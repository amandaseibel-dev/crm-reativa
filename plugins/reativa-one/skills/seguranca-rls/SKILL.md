---
name: seguranca-rls
description: Caminho obrigatório de segurança do CRM ReATIVA quando a alteração toca banco — função, RPC, view, tabela, trigger, policy, grant, bucket — ou quando muda quem vê o quê. Use ao criar ou substituir objeto no banco, ao mexer em perfil/carteira/mascaramento, e antes de pedir publicação. Aponta para a premissa de segurança e o checklist do repositório; não os reescreve.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Segurança: o caminho, não o conteúdo

A régua é `docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md` (13 seções) e
`docs/seguranca/CHECKLIST_SEGURANCA_DEPLOY.md`. **Leia de lá.** Nada é copiado
para cá: duas cópias de uma regra de segurança é uma regra de segurança a menos.

## Ambiente, antes de tudo

`bash "${CLAUDE_PLUGIN_ROOT}/scripts/ambiente.sh"`

PROD é `ahattpqrjmhkzsmnbdzs`; staging é `edlzlfbstshojxrudwaa`. O
`project_id` de `supabase/config.toml` é identificador **local** e parece o
staging — nunca use como prova de destino. Quem diz o destino é
`supabase/.temp/linked-project.json`, e neste checkout ele aponta para a
PRODUÇÃO.

## Ordem de leitura quando o diff toca banco

1. §1 a §6 da premissa — princípios, matriz de perfis, RLS, padrão de RPC,
   grants, views.
2. §7 e §8 se houver dado pessoal ou arquivo (mascaramento, URL assinada,
   bucket privado).
3. §9 — teste de perfis. Em produção, **sempre com `ROLLBACK`**; o padrão com
   `set local role` e `request.jwt.claims` está escrito lá.
4. §10 — checklist de migration. `CREATE OR REPLACE` pode restaurar grants
   padrão: reconferir grants e `search_path` é obrigatório, mesmo que a feature
   já tivesse sido validada.
5. Checklist de deploy, blocos A a F, preenchido item por item.

## Duas armadilhas que já custaram caro aqui

- **Função nova herda `EXECUTE` para `authenticated`; tabela e view não.**
  Depois de criar função, confira `information_schema.routine_privileges` — não
  `role_table_grants`.
- **Tabela nova herda `TRUNCATE` para `authenticated`** pelo default do schema
  `public`, e **RLS não cobre `TRUNCATE`**.

## Gate automático

`scripts/seguranca/run_security_gate.sh` roda a auditoria SQL e três checagens
de bundle. Precisa de `psql` e de `DATABASE_URL` **vindo do ambiente** — nunca
escreva a URL em arquivo do plugin, do repositório ou de autorização.

Checado em 16/10/2026 nesta máquina: **`psql` não está instalado**, então o
gate não roda localmente hoje. Isso não é motivo para dizer que passou: sem o
gate, o resultado é **NÃO COMPROVADO**.

## Conclusão

Toda entrega sensível encerra com o bloco da §13 preenchido de verdade. Campo
não conferido vai como `NÃO CONFERIDO`. Nenhuma demanda sensível recebe ☑ só
com teste funcional.
