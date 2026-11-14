# Evidência de produção — ações massivas (universo), leitura somente

Data da leitura: 2026-11-14. Projeto: `ahattpqrjmhkzsmnbdzs` (produção). Leitura por `select` apenas. Nenhuma alteração.

Este arquivo versiona as saídas que as guardas de MD5 e o benchmark assumem. Se uma saída mudar, a guarda deve recusar e este arquivo deve ser atualizado com nova leitura.

## 1. Consulta de MD5 das funções (somente leitura)

```sql
select
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='acoes_massivas_tipo_cobranca_alunos') as md5_tipo_cobranca_prod,
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='acoes_massivas_tipo_cobertura') as md5_cobertura_prod,
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='acoes_massivas_universo') as md5_universo_prod,
  (select count(*) from public.aluno_movimentacoes) as movimentacoes_prod;
```

Resultado (uma linha):

| função | MD5 em produção | Estado |
|---|---|---|
| `acoes_massivas_tipo_cobranca_alunos` | `323628b786a44f2a108210f8beafea8b` | pré-#941 (publicado) |
| `acoes_massivas_tipo_cobertura` | `5dcbd09deba6197cb6948d01f8b9caa5` | igual à definição da bancada |
| `acoes_massivas_universo` | `8f94a1687f0f3d13765ecf86db1d1e19` | pré-#941 (publicado) |
| `aluno_movimentacoes` (count) | 275.477 (leitura de 14/11; a tabela é viva) | — |

Leitura anterior do mesmo dia, para registro: `movimentacoes_prod` = 275.467. A contagem muda; o benchmark usa o valor fixo 275.467 como volume de referência, não como snapshot.

## 2. Consistência com a cadeia de migrações

- `tipo_cobranca_alunos` `323628b7` é o estado que o #941 valida antes de substituir (guarda em `20261112235500_acoes_massivas_valor_exigivel.sql.pendente`).
- Depois do #941 a função vira `d3e5dc840b72a6fc2d7d68b4dd3070c6`, medido na bancada de teste. É esse o estado sobre o qual a otimização (`20261113230000`) atua, e é o que a guarda dela confere.
- `acoes_massivas_tipo_cobertura` `5dcbd09d` é o valor que a guarda de cobertura da otimização confere; é igual à definição de `20260920100000`/bancada.

## 3. Índices de produção nas tabelas que o universo lê

Consulta:

```sql
select tablename, indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('aluno_movimentacoes','acoes_desfazer','alunos','casos',
  'acordos','acordos_titulos','parcelas','acordo_titulo_vinculo')
order by tablename, indexname;
```

Subconjunto replicado no benchmark (20 índices, `INDICES_PRODUCAO` em `supabase/tests/acoes_massivas_custo_benchmark/bench.mjs`): os índices de `aluno_movimentacoes` (aluno_id, registrado_em, (tipo, registrado_em), (registrado_por_email, registrado_em)), `casos` (aluno_id, operador_email, ficha aberta única por aluno), `acordos` (aluno_id, status, (aluno_id, lower(operador))), `acordos_titulos` ((aluno_id, vencimento)), `parcelas` (acordo_id; (acordo_id, status, vencimento)), `acordo_titulo_vinculo` (acordo_id, titulo_id) e `alunos` (responsavel_atual_email, curso, unidade, situacao_academica, data_ultimo_acionamento).

**Não replicados (diferenças restantes em relação à produção):**
- outros índices das mesmas tabelas que o universo não usa diretamente (há cerca de 200 índices no total em `public`);
- `acoes_desfazer`: produção tem `ix_acoes_desfazer_aluno (aluno_id, criado_em desc)` e `ix_acoes_desfazer_operador`; o fixture não tem `criado_em`, e nenhum dos dois cobre a subconsulta por `movimentacao_id` do universo. Essa subconsulta é varredura em produção e no benchmark;
- estatísticas reais de distribuição (o benchmark usa dados sintéticos com `analyze` após a carga);
- `statement_timeout` de produção: o caminho autenticado tem 8 s; o benchmark roda como superusuário, sem timeout.

## 4. Limite desta evidência

Esta leitura prova o estado de produção em 14/11/2026, não o de qualquer data posterior. Antes de aplicar a otimização, repetir a consulta da seção 1 e comparar com estes valores; qualquer divergência impede a aplicação pelas guardas da migração.
