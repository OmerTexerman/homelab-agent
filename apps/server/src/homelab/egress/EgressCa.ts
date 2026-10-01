// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The egress broker's install CA and the leaf certificates it signs for
 * hosts the proxy intercepts.
 *
 * Certificates are built with `@peculiar/x509` (already in the dependency
 * tree through `@simplewebauthn/server`) on Node's WebCrypto, ECDSA P-256.
 * Its dependency injection needs the Reflect metadata polyfill, imported
 * here before the library.
 *
 * The CA is generated once and persisted by the gateway. Leaf certificates
 * share one in-memory key pair and are cached per host.
 */
import "reflect-metadata";

import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as x509 from "@peculiar/x509";

type CryptoKey = NodeCrypto.webcrypto.CryptoKey;
type CryptoKeyPair = NodeCrypto.webcrypto.CryptoKeyPair;

const webcrypto = NodeCrypto.webcrypto;
x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const EC_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const CA_SUBJECT = "CN=Homelab Agent Egress Broker CA, O=Homelab Agent";
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const LEAF_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
/** A cached leaf is replaced once it is this old, well before it expires. */
const LEAF_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 60 * 1000;

/** What the gateway persists: the CA certificate and its PKCS#8 private key, both PEM. */
export interface EgressCaMaterial {
  readonly certPem: string;
  readonly keyPem: string;
}

function randomSerialNumber(): string {
  const bytes = NodeCrypto.randomBytes(16);
  // Positive INTEGER.
  bytes[0] = bytes[0]! & 0x7f;
  return bytes.toString("hex");
}

async function exportPkcs8Pem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key));
  return NodeCrypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

async function importSigningKey(keyPem: string): Promise<CryptoKey> {
  const der = NodeCrypto.createPrivateKey(keyPem).export({ type: "pkcs8", format: "der" });
  return webcrypto.subtle.importKey("pkcs8", der, EC_ALGORITHM, false, ["sign"]);
}

export async function generateEgressCa(now: Date = new Date()): Promise<EgressCaMaterial> {
  const keys = await webcrypto.subtle.generateKey(EC_ALGORITHM, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerialNumber(),
    name: CA_SUBJECT,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await exportPkcs8Pem(keys.privateKey) };
}

/** True when `material` parses and its CA certificate is valid at `now`. */
export function isUsableEgressCa(material: EgressCaMaterial, now: Date = new Date()): boolean {
  try {
    const cert = new NodeCrypto.X509Certificate(material.certPem);
    const key = NodeCrypto.createPrivateKey(material.keyPem);
    return (
      cert.ca &&
      cert.checkPrivateKey(key) &&
      new Date(cert.validFrom).getTime() <= now.getTime() &&
      new Date(cert.validTo).getTime() > now.getTime() + LEAF_VALIDITY_MS
    );
  } catch {
    return false;
  }
}

interface CachedLeaf {
  readonly issuedAt: number;
  readonly context: Promise<NodeTls.SecureContext>;
}

/** Signs and caches leaf certificates for intercepted hosts. */
export class EgressCertificateAuthority {
  readonly certPem: string;
  /** SHA-256 of the CA certificate (hex, colon-separated). */
  readonly fingerprint256: string;
  private readonly keyPem: string;
  private readonly leaves = new Map<string, CachedLeaf>();
  private leafKeys: Promise<{ readonly keys: CryptoKeyPair; readonly keyPem: string }> | undefined;
  private signingKey: Promise<CryptoKey> | undefined;

  constructor(material: EgressCaMaterial) {
    this.certPem = material.certPem;
    this.keyPem = material.keyPem;
    this.fingerprint256 = new NodeCrypto.X509Certificate(material.certPem).fingerprint256;
  }

  /** A TLS server context presenting a leaf for `host` (DNS name or IP literal). */
  secureContextFor(host: string, now: number = Date.now()): Promise<NodeTls.SecureContext> {
    const cached = this.leaves.get(host);
    if (cached !== undefined && now - cached.issuedAt < LEAF_REFRESH_MS) {
      return cached.context;
    }
    const context = this.issueLeaf(host, now).then((leaf) =>
      NodeTls.createSecureContext({ cert: leaf.certChainPem, key: leaf.keyPem }),
    );
    this.leaves.set(host, { issuedAt: now, context });
    context.catch(() => {
      if (this.leaves.get(host)?.context === context) {
        this.leaves.delete(host);
      }
    });
    return context;
  }

  /** Signs a fresh leaf for `host`: the PEM chain (leaf, then CA) and its PKCS#8 key. */
  async issueLeaf(
    host: string,
    now: number = Date.now(),
  ): Promise<{ readonly certChainPem: string; readonly keyPem: string }> {
    this.leafKeys ??= webcrypto.subtle
      .generateKey(EC_ALGORITHM, true, ["sign", "verify"])
      .then(async (keys) => ({ keys, keyPem: await exportPkcs8Pem(keys.privateKey) }));
    this.signingKey ??= importSigningKey(this.keyPem);
    const [{ keys, keyPem }, signingKey] = await Promise.all([this.leafKeys, this.signingKey]);
    const caCert = new x509.X509Certificate(this.certPem);
    const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const isIp = NodeNet.isIP(bareHost) !== 0;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerialNumber(),
      subject: `CN=${isIp ? bareHost : host.replace(/[,+=<>#;"\\]/g, "")}`,
      issuer: caCert.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + LEAF_VALIDITY_MS),
      signingAlgorithm: SIGNING_ALGORITHM,
      publicKey: keys.publicKey,
      signingKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension(
          [{ type: isIp ? "ip" : "dns", value: bareHost }],
          false,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey),
      ],
    });
    return { certChainPem: `${cert.toString("pem")}\n${this.certPem}`, keyPem };
  }
}
