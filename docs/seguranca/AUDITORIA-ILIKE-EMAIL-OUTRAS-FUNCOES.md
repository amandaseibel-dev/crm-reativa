# Auditoria separada — ILIKE inseguro em e-mail fora da Central ULBRA

Achado do Guardião na #945. Não corrigido nesta PR.

- `supabase/functions/admin-definir-senha/index.ts:94`: `ilike` cru em e-mail.
- `supabase/functions/documento-financeiro-url/index.ts:124`: `ilike` cru em e-mail.

Não auditei o portão de cada função. Próximo passo: aplicar a mesma correção (igualdade normalizada e unicidade ativa) em PR própria, com teste de integração.
