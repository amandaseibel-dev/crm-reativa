# Autorização M1 — PR #937 (Preventivo: Visão geral e correção do portão)

Status: linhas `pendente` com validade fixa. Nada foi aplicado quando este documento foi escrito.

- Aprovadora: Amanda Seibel (aprovação expressa, 13/11/2026, para o head `9039f720` da #937).
- Executor técnico único: sessão Claude Code com o conector Supabase autorizado (`sessao-claude-code-conector-supabase`). Nenhuma outra sessão executa.
- Projeto: `ahattpqrjmhkzsmnbdzs` (produção). Validade das duas linhas: até `2026-11-13T17:45:00Z`. Sem renovação automática; se expirar, nova PR.

| Ordem | Migration | SHA-256 | Rollback (SHA-256) |
|---|---|---|---|
| 1 | `20261112120000_preventivo_visao_geral_historico` | `2e44e45fca13204f2a2f82f65f8ba4f7aed20bafad721556b7f05c8f1189cf78` | `e16bc51d444e3ffd4bff007125bc412f53a66f64df5f80e7d96c91011fba0c9b` |
| 2 | `20261112130000_preventivo_gestao_exige_papel_no_jwt_sem_email` | `0c6714dbc979ccedf0148de22b38106c7eb55464909ecc6aa83babd9e6f7fa8d` | `fa27d60dcd145f1b91d551f56d20eb9f4002df8d862e68845d5bfe9fdb50dd0d` |

Arquivos em `supabase/migrations/` e `supabase/rollbacks/` da PR #937 (head `9039f720`).

Sequência: reconferir pré-condições (ledger sem as duas versões, md5 do portão `6e00d65195b2bb7fc771710eb5403244`, 4 RPCs ausentes) → aplicar a 1 → validar → aplicar a 2 → validar → só então mesclar a #937. Falha em qualquer validação: rollback da etapa e parar.

Pré-condições lidas em produção em 13/11/2026 (leitura): 0 versões no ledger, md5 do portão igual, 0 RPCs novas, 0 crons do Preventivo, última versão `20261112171018`.

Depois da aplicação, PR própria muda `status` para `aplicada` e registra as versões geradas pelo servidor e a hora da conferência da linha (RUNBOOK §6 e §7).
