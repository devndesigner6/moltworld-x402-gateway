from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import warnings
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from algosdk import encoding, mnemonic as algo_mnemonic, transaction
from algosdk.account import address_from_private_key
from algosdk.v2client import algod
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .mandates import MandatePayer

MICRO = 1_000_000
ALGOD = {
    "mainnet": "https://mainnet-api.algonode.cloud",
    "testnet": "https://testnet-api.algonode.cloud",
}
DEFAULT_API_ORIGIN = "https://motoworld-wif.vercel.app"
EVM_EOA_AUTOPAY_ACK = "I_UNDERSTAND_LOCAL_EVM_EOA_AUTOPAY_IS_NOT_A_MANDATE"


def _assert_evm_eoa_autopay_allowed() -> None:
    """Require an explicit local-only acknowledgement for unrestricted EOA keys."""
    environments = [
        os.environ.get("NODE_ENV", "").strip().lower(),
        os.environ.get("MOLTWORLD_ENV", "").strip().lower(),
    ]
    if "production" in environments:
        raise ValueError(
            "Refusing EVM EOA auto-payment in production. This key has no "
            "owner-authorized on-chain cap or mandate; use caller-signed/browser "
            "or mandate architecture instead."
        )
    active_environments = [environment for environment in environments if environment]
    if not active_environments or any(environment not in {"local", "development", "dev", "test"} for environment in active_environments):
        raise ValueError(
            "Refusing EVM EOA auto-payment outside local/development environments. "
            "This key has no owner-authorized on-chain cap or mandate."
        )
    role = os.environ.get("MOLTWORLD_EVM_KEY_ROLE", "").strip().lower()
    if role != "dedicated":
        raise ValueError(
            "Refusing EVM EOA auto-payment for a master/primary wallet key. "
            "Use only a dedicated, disposable local EOA; this path is not a mandate."
        )
    if os.environ.get("MOLTWORLD_ALLOW_EVM_EOA_AUTOPAY") != EVM_EOA_AUTOPAY_ACK:
        raise ValueError(
            "EVM EOA auto-payment is disabled by default. For local/development "
            f"only, set MOLTWORLD_ALLOW_EVM_EOA_AUTOPAY={EVM_EOA_AUTOPAY_ACK}. "
            "Use a dedicated disposable EOA, never a user's master key. The "
            "budget is local/process-only, not an owner-authorized on-chain cap "
            "or mandate."
        )
    warnings.warn(
        "WARNING: local EVM EOA auto-payment is enabled. This is an unrestricted "
        "dedicated EOA key with local/process budgets only—not an owner-authorized "
        "on-chain cap or mandate. Never use a user's master key.",
        RuntimeWarning,
        stacklevel=3,
    )


class MoltworldError(Exception):
    def __init__(self, message: str, status: int, code: Optional[str] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


@dataclass
class PaidResult:
    data: Any
    request_id: Optional[str]
    receipt: Optional[Dict[str, Any]]
    verified: bool
    paid_micro: int
    replayed: bool
    paid_atomic: Optional[int] = None
    paid_asset: Optional[str] = None
    paid_decimals: Optional[int] = None


def canonical_json(value: Any) -> str:
    """Same canonical form the gateway signs: sorted keys, no whitespace, non-ASCII kept."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_receipt(receipt: Dict[str, Any], public_key_b64: str, request: Optional[bytes] = None, response: Optional[bytes] = None) -> bool:
    """True when the signature is valid and the hashes match the bytes you sent and received."""
    payload = {k: v for k, v in receipt.items() if k != "sig"}
    sig = base64.urlsafe_b64decode(receipt["sig"] + "=" * (-len(receipt["sig"]) % 4))
    try:
        VerifyKey(base64.b64decode(public_key_b64)).verify(canonical_json(payload).encode("utf-8"), sig)
    except (BadSignatureError, KeyError, ValueError):
        return False
    if request is not None and _sha256(request) != receipt["requestSha256"]:
        return False
    if response is not None and _sha256(response) != receipt["responseSha256"]:
        return False
    return True


class MoltworldClient:
    """Moltworld x402 client.

    Algorand credentials use the legacy local transaction path. Supplying
    ``evm_private_key`` selects the WIF path, which delegates all EVM/Permit2
    typed-data construction and signing to x402 2.27.0.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_API_ORIGIN,
        private_key: Optional[str] = None,
        mnemonic: Optional[str] = None,
        mandate: Optional[Union[str, Dict[str, Any]]] = None,
        agent_key: Optional[str] = None,
        max_per_request_usd: float = 1.0,
        budget_usd: Optional[float] = None,
        expected_pay_to: Optional[str] = None,
        algod_url: Optional[str] = None,
        timeout: float = 120.0,
        evm_private_key: Optional[str] = None,
        evm_rpc_url: Optional[str] = None,
    ):
        self._mandate = MandatePayer(mandate, agent_key) if mandate else None
        if mnemonic:
            private_key = algo_mnemonic.to_private_key(mnemonic)
        if evm_private_key and (private_key or mnemonic or mandate):
            raise ValueError("Choose either Algorand credentials or evm_private_key, not both.")
        self._evm = evm_private_key is not None
        if self._evm:
            _assert_evm_eoa_autopay_allowed()
        if not self._evm and not private_key and not self._mandate:
            raise ValueError("MoltworldClient needs private_key (algosdk base64), mnemonic, evm_private_key, or mandate with agent_key.")
        self._sk = private_key
        self._evm_private_key = evm_private_key
        self._evm_rpc_url = evm_rpc_url
        self.address = None
        self._x402 = None
        self._x402_http = None
        if self._evm:
            from eth_account import Account
            from x402 import x402ClientSync
            from x402.mechanisms.evm.exact import register_exact_evm_client
            from x402.mechanisms.evm.signers import EthAccountSigner

            account = Account.from_key(evm_private_key)
            self.address = account.address
            self._evm_signer = EthAccountSigner(account)
            self._x402 = x402ClientSync()
            register_exact_evm_client(self._x402, self._evm_signer)
            # The gateway's WIF asset is intentionally non-default; the local
            # guard below is the authoritative cap/asset policy.
            self._x402.set_spend_controls(False)
            from x402.http.x402_http_client import x402HTTPClientSync
            self._x402_http = x402HTTPClientSync(self._x402)
        else:
            self.address = self._mandate.owner if self._mandate else address_from_private_key(private_key)
        self.base_url = base_url.rstrip("/")
        self.max_per_request_micro = int(round(max_per_request_usd * MICRO))
        self.budget_micro = None if budget_usd is None else int(round(budget_usd * MICRO))
        self.spent_micro = 0
        self.timeout = timeout
        self._expected_pay_to = expected_pay_to
        self._algod_url = algod_url
        self._health: Optional[Dict[str, Any]] = None
        self._keys: Optional[Dict[str, str]] = None

    # ------------------------------------------------------------------ http
    def _request(self, method: str, path: str, body: Optional[bytes] = None, headers: Optional[Dict[str, str]] = None):
        req = urllib.request.Request(f"{self.base_url}{path}", data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers.items()), err.read()

    def _get_json(self, path: str) -> Any:
        status, _, raw = self._request("GET", path)
        if status != 200:
            raise MoltworldError(f"GET {path} failed", status, body=raw.decode("utf-8", "replace"))
        return json.loads(raw)

    def health(self) -> Dict[str, Any]:
        if self._health is None:
            self._health = self._get_json("/health")
        return self._health

    def receipt_keys(self) -> Dict[str, str]:
        if self._keys is None:
            doc = self._get_json("/.well-known/moltworld-receipts.json")
            self._keys = {k["kid"]: k["publicKey"] for k in doc["keys"]}
        return self._keys

    @property
    def spent_usd(self) -> float:
        return self.spent_micro / MICRO

    # -------------------------------------------------------------- payments
    def _algod(self) -> algod.AlgodClient:
        url = self._algod_url or ALGOD["mainnet" if self.health().get("network") == "mainnet" else "testnet"]
        return algod.AlgodClient("", url)

    @staticmethod
    def _wif_atomic_amount(quote_micro: int, price_scaled18: int, decimals: int = 18) -> int:
        if quote_micro < 0 or price_scaled18 <= 0 or decimals != 18:
            raise ValueError("Invalid WIF quote or price metadata.")
        numerator = quote_micro * (10 ** (decimals + 12))
        return (numerator + price_scaled18 - 1) // price_scaled18

    def _validate_wif_requirement(self, req: Any) -> int:
        """Validate all gateway-advertised WIF terms before x402 can sign."""
        health = self.health()
        expected_network = health.get("network_caip2")
        expected_asset = health.get("payment_asset")
        expected_pay_to = self._expected_pay_to or health.get("pay_to")
        if health.get("payment_chain") != "robinhood":
            raise MoltworldError("WIF payments require the Robinhood payment rail.", 402, "wrong_payment_chain")
        if not isinstance(expected_network, str) or not expected_network.startswith("eip155:") or req.network != expected_network:
            raise MoltworldError("Refusing a WIF payment on an unadvertised EVM chain.", 402, "unexpected_network")
        if req.scheme != "exact":
            raise MoltworldError("WIF requires the exact x402 scheme.", 402, "wrong_scheme")
        if not expected_asset or req.asset.lower() != str(expected_asset).lower():
            raise MoltworldError("Refusing a WIF payment for an unadvertised asset.", 402, "unexpected_asset")
        if not expected_pay_to or req.pay_to.lower() != str(expected_pay_to).lower():
            raise MoltworldError("Refusing to pay an unadvertised payTo address.", 402, "unexpected_payee")
        extra = req.extra or {}
        if extra.get("assetTransferMethod") != "permit2":
            raise MoltworldError("WIF requires Permit2 exact transfer.", 402, "wrong_transfer_method")
        if extra.get("symbol") != "WIF" or int(extra.get("decimals", -1)) != 18:
            raise MoltworldError("WIF must be advertised as WIF with 18 decimals.", 402, "wrong_asset_metadata")
        quote_micro = extra.get("quoteUsdMicro", extra.get("quotedUsdMicro"))
        price_scaled = extra.get("wifPriceUsdScaled18")
        if quote_micro is None or price_scaled is None:
            raise MoltworldError("WIF payment is missing exact quote metadata.", 402, "missing_wif_quote")
        try:
            quote_micro = int(quote_micro)
            price_scaled = int(price_scaled)
            expected_atomic = self._wif_atomic_amount(quote_micro, price_scaled)
            actual_atomic = int(req.amount)
        except (TypeError, ValueError):
            raise MoltworldError("WIF quote metadata is invalid.", 402, "invalid_wif_quote") from None
        if actual_atomic != expected_atomic:
            raise MoltworldError("WIF atomic amount does not exactly match the USD quote and price.", 402, "amount_mismatch")
        if quote_micro > self.max_per_request_micro:
            raise MoltworldError("WIF quote exceeds max_per_request_usd.", 402, "over_request_cap")
        if self.budget_micro is not None and self.spent_micro + quote_micro > self.budget_micro:
            raise MoltworldError("Budget would be exceeded.", 402, "over_budget")
        return quote_micro

    def _payment_header(self, payment_required: Dict[str, Any]) -> tuple[str, int, Optional[int], Optional[str], Optional[int]]:
        if self._evm:
            if not self._x402_http:
                raise MoltworldError("EVM x402 client is not initialized.", 500)
            try:
                required = self._x402_http.get_payment_required_response(lambda name: base64.b64encode(json.dumps(payment_required).encode()).decode() if name.lower() == "payment-required" else None)
                accepts = [req for req in required.accepts if req.network == self.health().get("network_caip2")]
                if len(accepts) != 1:
                    raise MoltworldError("No single exact WIF payment option offered.", 402)
                quote_micro = self._validate_wif_requirement(accepts[0])
                # Hook is deliberately before create_payment_payload; x402 then delegates Permit2 signing.
                def guard(ctx: Any):
                    self._validate_wif_requirement(ctx.requirements)
                    return None
                self._x402.on_before_payment_creation(guard)
                payload = self._x402.create_payment_payload(required)
                encoded = self._x402_http.encode_payment_signature_header(payload)["PAYMENT-SIGNATURE"]
                req = accepts[0]
                return encoded, quote_micro, int(req.amount), req.asset, int(req.extra["decimals"])
            except MoltworldError:
                raise
            except Exception as err:
                raise MoltworldError(f"WIF payment refused before signing: {err}", 402, "payment_guard_failed") from err

        accepts = [a for a in payment_required.get("accepts", []) if a.get("scheme") == "exact" and str(a.get("network", "")).startswith("algorand:")]
        if not accepts:
            raise MoltworldError("No Algorand exact payment option offered.", 402)
        req = accepts[0]
        amount = int(req["amount"])
        pay_to = self._expected_pay_to or self.health()["pay_to"]
        if req["payTo"] != pay_to:
            raise MoltworldError(f"Refusing to pay {req['payTo']}; expected {pay_to}.", 402, "unexpected_payee")
        if amount > self.max_per_request_micro:
            raise MoltworldError(f"Price {amount / MICRO} USDC exceeds max_per_request_usd.", 402, "over_request_cap")
        if self.budget_micro is not None and self.spent_micro + amount > self.budget_micro:
            raise MoltworldError("Budget would be exceeded.", 402, "over_budget")
        sp = self._algod().suggested_params()
        fee_payer = (req.get("extra") or {}).get("feePayer")
        stamp = int(time.time() * 1000)
        version = payment_required.get("x402Version", 2)
        if self._mandate:
            if not fee_payer:
                raise MoltworldError("Mandate payments need a facilitator that sponsors fees.", 402, "no_fee_payer")
            try:
                group_b64, index = self._mandate.payment_group(sp, req, amount, fee_payer, version, stamp)
            except ValueError as err:
                raise MoltworldError(str(err), 402, "mandate_refused") from err
            payload = {"x402Version": version, "payload": {"paymentGroup": group_b64, "paymentIndex": index}, "extensions": payment_required.get("extensions"), "resource": payment_required.get("resource"), "accepted": req}
            payload = {k: v for k, v in payload.items() if v is not None}
            return base64.b64encode(json.dumps(payload).encode()).decode(), amount, None, None, None
        pay_sp = transaction.SuggestedParams(0, sp.first, sp.last, sp.gh, sp.gen, flat_fee=True, min_fee=sp.min_fee)
        payment = transaction.AssetTransferTxn(sender=self.address, sp=pay_sp if fee_payer else sp, receiver=req["payTo"], amt=amount, index=int(req["asset"]), note=f"x402-payment-v{version}-{stamp}".encode())
        if fee_payer:
            fee_sp = transaction.SuggestedParams(2 * max(sp.min_fee, 1000), sp.first, sp.last, sp.gh, sp.gen, flat_fee=True, min_fee=sp.min_fee)
            sponsor = transaction.PaymentTxn(sender=fee_payer, sp=fee_sp, receiver=fee_payer, amt=0, note=f"x402-fee-payer-{stamp}".encode())
            group = transaction.assign_group_id([sponsor, payment])
            sponsor, payment = group[0], group[1]
            group_b64 = [encoding.msgpack_encode(sponsor), encoding.msgpack_encode(payment.sign(self._sk))]
            index = 1
        else:
            group_b64 = [encoding.msgpack_encode(payment.sign(self._sk))]
            index = 0
        payload = {"x402Version": version, "payload": {"paymentGroup": group_b64, "paymentIndex": index}, "extensions": payment_required.get("extensions"), "resource": payment_required.get("resource"), "accepted": req}
        payload = {k: v for k, v in payload.items() if v is not None}
        return base64.b64encode(json.dumps(payload).encode()).decode(), amount, None, None, None

    # ------------------------------------------------------------------- api
    def quote(self, model: str, body: Dict[str, Any]) -> Dict[str, Any]:
        status, _, raw = self._request("POST", "/v1/quote", json.dumps({**body, "model": model}).encode(), {"Content-Type": "application/json"})
        data = json.loads(raw)
        if status != 200:
            raise MoltworldError(data.get("error", {}).get("message", "quote failed"), status, data.get("error", {}).get("code"), data)
        return data["quote"]

    def call(self, path: str, body: Dict[str, Any]) -> PaidResult:
        is_chat = bool(re.fullmatch(r"/v1/models/[^/]+/chat/completions", path))
        is_market_call = bool(re.fullmatch(r"/v1/market/[a-z0-9][a-z0-9-]{2,47}/call", path))
        if self._evm and not (is_chat or is_market_call):
            raise MoltworldError("WIF mode supports chat and marketplace calls only; no payment signature was created.", 400, "wif_endpoint_unsupported")
        request_bytes = json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        status, resp_headers, raw = self._request("POST", path, request_bytes, headers)
        lower = {k.lower(): v for k, v in resp_headers.items()}
        paid = 0
        paid_atomic = None
        paid_asset = None
        paid_decimals = None
        if status == 402 and "payment-required" in lower:
            payment_required = json.loads(base64.b64decode(lower["payment-required"]))
            header, paid, paid_atomic, paid_asset, paid_decimals = self._payment_header(payment_required)
            self.spent_micro += paid
            payment_header_name = "Payment-Signature" if self._evm else "Payment-Signature"
            status, resp_headers, raw = self._request("POST", path, request_bytes, {**headers, payment_header_name: header})
            lower = {k.lower(): v for k, v in resp_headers.items()}
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw.decode("utf-8", "replace")
        if status >= 400:
            if lower.get("moltworld-payment-status") == "uncharged":
                self.spent_micro -= paid
            err = data.get("error", {}) if isinstance(data, dict) else {}
            raise MoltworldError(err.get("message", f"HTTP {status}"), status, err.get("code"), data)
        receipt = None
        verified = False
        if "moltworld-receipt" in lower:
            encoded = lower["moltworld-receipt"]
            receipt = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            key = self.receipt_keys().get(receipt["kid"])
            verified = bool(key) and check_receipt(receipt, key, request_bytes, raw)
            if receipt.get("assetSymbol") == "WIF":
                paid_atomic = int(receipt["amountAtomic"])
                paid_asset = receipt["asset"]
                paid_decimals = int(receipt["assetDecimals"])
        return PaidResult(data=data, request_id=lower.get("moltworld-request-id"), receipt=receipt, verified=verified, paid_micro=receipt["amountMicro"] if receipt else paid, replayed=lower.get("moltworld-replay") == "true", paid_atomic=paid_atomic, paid_asset=paid_asset, paid_decimals=paid_decimals)

    def chat(self, model: str, messages: List[Dict[str, str]], max_tokens: Optional[int] = None, temperature: Optional[float] = None) -> PaidResult:
        body: Dict[str, Any] = {"messages": messages}
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if temperature is not None:
            body["temperature"] = temperature
        return self.call(f"/v1/models/{model}/chat/completions", body)

    def image(self, model: str, prompt: str, n: int = 1, size: Optional[str] = None) -> PaidResult:
        if self._evm:
            raise MoltworldError("WIF mode supports chat and marketplace calls only; no payment signature was created.", 400, "wif_endpoint_unsupported")
        body: Dict[str, Any] = {"prompt": prompt, "n": n}
        if size:
            body["size"] = size
        return self.call(f"/v1/models/{model}/images/generations", body)

    def speech(self, model: str, text: str, voice: Optional[str] = None) -> PaidResult:
        if self._evm:
            raise MoltworldError("WIF mode supports chat and marketplace calls only; no payment signature was created.", 400, "wif_endpoint_unsupported")
        body: Dict[str, Any] = {"input": text}
        if voice:
            body["voice"] = voice
        return self.call(f"/v1/models/{model}/audio/speech", body)

    def video(self, model: str, prompt: str, duration: Optional[int] = None, wait: bool = False, timeout: float = 900) -> PaidResult:
        if self._evm:
            raise MoltworldError("WIF mode supports chat and marketplace calls only; no payment signature was created.", 400, "wif_endpoint_unsupported")
        body: Dict[str, Any] = {"prompt": prompt}
        if duration:
            body["duration"] = duration
        result = self.call(f"/v1/models/{model}/videos/generations", body)
        if wait:
            result.data = self.wait_for_job(result.data["id"], timeout)
        return result

    def market(self, slug: str, body: Dict[str, Any]) -> PaidResult:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,47}", slug):
            raise MoltworldError("Marketplace slug must be 3-48 lowercase letters, numbers, or hyphens.", 400, "invalid_market_slug")
        return self.call(f"/v1/market/{slug}/call", body)

    def job(self, job_id: str) -> Dict[str, Any]:
        return self._get_json(f"/v1/jobs/{job_id}")

    def wait_for_job(self, job_id: str, timeout: float = 900, interval: float = 5) -> Dict[str, Any]:
        deadline = time.time() + timeout
        while True:
            job = self.job(job_id)
            if job["status"] in ("completed", "failed"):
                return job
            if time.time() > deadline:
                raise TimeoutError(f"Job {job_id} still {job['status']}")
            time.sleep(interval)
