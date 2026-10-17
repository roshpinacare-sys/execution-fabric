// סריקת-סודות על ארטיפקט לפני-העברה לגיט (worklog Task 20).
// הרקע: R11 — מפתחות-שורש נדחפו ל-8 ריפואים בעבר; השער חוסם את החזרת-התבנית.
// כלל-עיצוב: תבניות מבוססות-קידומת-מוכרת בלבד (שווא-שלילי מועדף על שווא-חיובי-רגיש);
// הדיווח מחזיר את שם-התבנית בלבד — אף ערך/קטע-תוכן לא יוצא מהפונקציה.

interface SecretPattern {
  name: string
  re: RegExp
}

const PATTERNS: SecretPattern[] = [
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-app-token', re: /\bghs_[A-Za-z0-9]{30,}\b/ },
  { name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'nvidia-nim-key', re: /\bnvapi-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: 'slack-token', re: /\bxox[abpr]-[A-Za-z0-9\-]{10,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'env-secret-assignment', re: /\b(NVIDIA_API_KEY|IPAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|PAT|SECRET|PASSPHRASE)\s*=\s*["']?[^\s"']{16,}/ },
  { name: 'zhipu-signed-key', re: /\b[0-9a-f]{32}\.[A-Za-z0-9_\-]{16,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
  { name: 'generic-high-entropy-hex', re: /\b[0-9a-f]{64,}\b/ },
]

export interface ScanResult {
  clean: boolean
  hits: { name: string; count: number }[]
}

export function scanSecrets(artifact: string): ScanResult {
  const hits: { name: string; count: number }[] = []
  for (const p of PATTERNS) {
    const m = artifact.match(new RegExp(p.re.source, 'g'))
    if (m && m.length > 0) {
      hits.push({ name: p.name, count: m.length })
    }
  }
  return { clean: hits.length === 0, hits }
}
