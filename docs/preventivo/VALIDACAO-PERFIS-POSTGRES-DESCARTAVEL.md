# Validação de perfis e grants do Preventivo — Postgres descartável

Cobre as migrations `20261112120000` (visão geral, mudanças, histórico) e
`20261112130000` (portão exige papel no JWT sem e-mail). Teste:
`supabase/tests/preventivo_perfis_grants_supabase.test.js` (15 casos, ~10 s,
sem rede, sem segredo, sem dado real).

## O que o ambiente reproduz
- Papéis `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator`.
- `SET ROLE` real por chamada + `request.jwt.claims` (como o PostgREST).
- `auth.jwt()` com o corpo do Supabase.
- Default privileges do dono `postgres`: tabelas/sequências com ALL para os três
  papéis (a armadilha do projeto); funções com EXECUTE de PUBLIC + authenticated
  + service_role, **sem anon explícito** (ACL medida em produção em 28/09 e
  12/11: `{postgres, authenticated, service_role}`).
- RLS + FORCE nas 11 tabelas `prev_` (vindo das migrations do repositório).
- Cadeia completa das migrations `preventivo_*`, em ordem, mais as duas novas.

## Resultado (15/15)
| Perfil | Portão | RPCs novas | Leitura direta `prev_*` |
|---|---|---|---|
| `anon` | sem EXECUTE (`permission denied for function`) | sem EXECUTE | `permission denied` |
| `authenticated` sem e-mail (claims `{role}`, `is_anonymous`, `email:""`, `{}`, ausente) | falso | 42501 | 0 linhas |
| `authenticated` com `role=service_role` forjado | falso | — | — |
| Amanda ADM / e-mail desconhecido / usuário desativado | falso | 42501 | 0 linhas |
| Gestão (Amanda), Ângela, Gustavo (ativos) | verdadeiro | dados | linhas |
| `service_role` real; sessão de sistema/cron (sem papel, sem JWT) | verdadeiro | — | — |

Também: nenhuma função `preventivo_*` executável por `anon` nem por PUBLIC; RLS
e FORCE nas 11 tabelas; o histórico não devolve CPF nem `carteira_id`.

**Prova de que o ambiente detecta a falha:** sem a migration `130000`,
`authenticated` sem e-mail PASSA no portão (a falha original reproduzida); com
ela, não passa, e gestão + diretoria continuam passando.

## Limitações (o que isto NÃO prova)
1. Não é o Supabase: sem PostgREST/GoTrue; o `SET ROLE` e os claims são
   montados pelo teste. A cadeia real de produção pode ter default privileges
   que a medição não capturou (a medição é da ACL das funções, não de
   `pg_default_acl`).
2. Os atributos exatos dos papéis e `pg_default_acl` de produção **não foram
   relidos nesta rodada**: o conector do Supabase devolveu erro 500 em todas as
   consultas depois da primeira hora. Reler antes da aprovação final (consulta
   abaixo).
3. Login anônimo: é configuração do painel (Auth → Providers → Anonymous). O
   teste só prova que, SE existir JWT `authenticated` sem e-mail, ele não passa.
4. `usuarios` é uma tabela mínima de teste; o `usuarios` real (RLS, colunas,
   e-mails e `ativo`) não é exercitado.
5. A branch ainda não contém a migration `20261008172859` (mesclada na main pela
   #938): o teste parte do portão de e-mail único de 28/09 e a `130000` leva
   aos três e-mails. O estado final é o mesmo da produção; rebasear na main
   antes do merge elimina a diferença.
6. PGlite ≠ Postgres 17 do Supabase em detalhes de plano/extensões; a lógica de
   privilégio e RLS exercitada aqui é a nativa do Postgres.
7. Edge Function `prev-sincronizar` (JWT do usuário via anon-key) não é
   exercitada ponta a ponta.

## Leituras de produção para refazer antes de aprovar (somente leitura)
```sql
select count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) anon_exec, count(*) total
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'preventivo\_%';
select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role','authenticator');
select count(*) from auth.users where is_anonymous;
```
Esperado: `anon_exec = 0`; `service_role` BYPASSRLS; zero usuários anônimos.

## Ordem e autorização para aplicar (NADA foi aplicado)
1. `20261112120000` (só funções novas de leitura; reversão = drop das 4).
2. `20261112130000` (troca o corpo de `preventivo_e_gestao()`; reversão restaura
   o corpo vivo de 08/10 com os três e-mails).
Cada uma exige autorização específica da gestão. Depois de aplicar: conferir o
ledger e repetir as leituras acima + `select public.preventivo_e_gestao()` como
cada perfil.
