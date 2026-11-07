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

- **Objeto novo no schema `public` herda privilégio: função, tabela, view e
  matview — todos.** Não é "função sim, tabela e view não", como esta skill
  afirmou até 06/11/2026; a correção está medida logo abaixo. O que muda de um
  para o outro é **qual catálogo responde**: função se confere em
  `information_schema.routine_privileges`, relação (tabela, view, matview) em
  `information_schema.role_table_grants` ou `has_table_privilege`.
- **Tabela nova herda `TRUNCATE` para `authenticated`** pelo default do schema
  `public`, e **RLS não cobre `TRUNCATE`**.

### A herança de grants, medida (06/11/2026)

Quem decide a herança é `pg_default_acl`, não o tipo do objeto. Lido em
produção (`ahattpqrjmhkzsmnbdzs`), somente leitura, há **duas** entradas para o
schema `public` — e `defaclobjtype = 'r'` vale para **toda relação**, inclusive
view:

```
FOR ROLE postgres        tipo r  ->  authenticated=arwdDxtm, service_role=arwdDxtm
FOR ROLE supabase_admin  tipo r  ->  anon=arwdDxtm, authenticated=arwdDxtm,
                                     service_role=arwdDxtm
```

Qual das duas vale depende do papel que cria o objeto — e **isso não foi
medido** (ver "NÃO COMPROVADO", ao final). O que **as duas** têm em comum, e é
o que decide o padrão: **`authenticated` e `service_role` nascem com ALL** em
qualquer um dos casos.

Por que isso importa numa view, e não é teoria:

1. **`grant select` sozinho não restringe nada.** Sobre um ALL que já está lá,
   ele é no-op. A view fica legível *e gravável*.
2. **View simples é atualizável por padrão no Postgres**, então o `insert`,
   `update` ou `delete` **atravessa** para a tabela base. O que sobra depois
   disso **depende do `security_invoker`**, e a diferença é grande:
   - **com `security_invoker = on`**: o acesso à base usa os direitos de quem
     invocou, então a RLS e os gatilhos da tabela ainda barram — a proteção
     passou a ser uma camada adiante do que o arquivo prometia, mas existe;
   - **sem a opção** (que é o **default** do Postgres): o acesso à base é feito
     com os direitos do **dono** da view, e o dono normalmente **contorna a
     RLS** — não "sobra" RLS nenhuma. Só os gatilhos continuam de pé.

   Por isso as duas coisas andam juntas e nenhuma substitui a outra: o
   `revoke` fecha a escrita pela view, e o `security_invoker` garante que, se
   ela acontecer, continue sujeita à RLS da base.

Dois incidentes do repositório provam a herança em relação, não em função:
`supabase/migrations/20261002121000_mv_saude_carteira_acl_sem_authenticated.sql`
(matview recriada em 02/10/2026 voltou com `authenticated` na ACL) e a linha 5
de `supabase/migrations/20260930232237_mrl_privilegios_como_audit_log.sql`. E
`supabase/migrations/20260805170000_grants_minimos_default_privileges.sql`
(linhas 21-23) revoga os defaults de `anon` — é por isso que `anon` aparece só
na entrada de `supabase_admin`.

**O padrão, portanto, é revogar antes de conceder** — e revogar dos quatro, não
de dois. O bloco abaixo é de **relação** (tabela, view, matview):

```sql
revoke all on public.<objeto> from public;
revoke all on public.<objeto> from anon;
revoke all on public.<objeto> from authenticated;
revoke all on public.<objeto> from service_role;
grant select on public.<objeto> to authenticated;   -- só o que o caso exige
```

**Para função a sintaxe é outra, e copiar a de cima não funciona:**
`revoke all on function public.<f>(<tipos>) from ...`, `grant execute`, e a
conferência é por `has_function_privilege` / `information_schema.routine_privileges`.
O erro é alto (objeto errado), não silencioso — mas é retrabalho.

E a asserção correspondente, no mesmo arquivo, para cada `grant`/`revoke` —
conferir a existência do objeto não prova a permissão dele:

```sql
if has_table_privilege('authenticated','public.<objeto>','INSERT')
   or has_table_privilege('authenticated','public.<objeto>','UPDATE')
   or has_table_privilege('authenticated','public.<objeto>','DELETE') then
  raise exception 'PROVA: o objeto aceita escrita de authenticated';
end if;
```

Em **view**, isto é obrigatório além do revoke: `with (security_invoker = on)`.
Sem a opção, a view roda com os direitos do dono e **passa por cima da RLS da
tabela base** — é o item `VIEW_BYPASS_RLS` (7) de
`scripts/seguranca/auditoria_seguranca.sql`. Confira pela
`pg_options_to_table`, o mesmo idioma do gate, e não casando a string
`'security_invoker=on'`, que quebra se alguém reescrever como `= true`.

Exemplo completo e revisado, com guarda de pré-condição, provas e reversa:
`supabase/aguardando_aprovacao/20261106190000_ulbra_vinculos_view_confirmados.sql.pendente`.

**O que segue NÃO COMPROVADO**, e vale declarar em vez de deixar o leitor
supor:

1. A leitura acima é de `pg_default_acl` em **06/11/2026**. Um
   `ALTER DEFAULT PRIVILEGES` novo, para outro grantee ou outro `FOR ROLE`,
   muda o conjunto e não aparece em nenhum arquivo do repositório.
2. **Qual das duas entradas se aplica** depende do papel de conexão com que o
   `apply_migration` roda. Dizer que ele cai na de `FOR ROLE postgres` é
   inferência: nenhum arquivo do repositório fixa isso, e não foi medido.

As duas fecham do mesmo jeito, e é leitura barata: reler `pg_default_acl` e
conferir `current_user` no momento da aplicação. **Na prática não muda o
padrão** — as duas entradas dão ALL a `authenticated` e `service_role`, e a de
`supabase_admin` ainda inclui `anon`, então revogar dos quatro cobre os dois
casos. É por isso que o padrão é revogar dos quatro, e não dos dois que a
medição de hoje mostraria.

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
