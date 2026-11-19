# Entrega Fase 2 — `acoes_massivas_universo`: recorte por responsável pelo caso

**Status:** preparado e validado tecnicamente. **NÃO executado.** Sem autorização de execução, migration, merge ou deploy.
**Destinatário:** agente de Banco (Fase 2), mediante autorização nominal da responsável.

## 1. Escopo

- Função: `public.acoes_massivas_universo`
- Projeto: `ahattpqrjmhkzsmnbdzs` — **confirmar antes da execução** que é o banco de produção do CRM (o nome do projeto sugere conta pessoal; ver `reativa-one:ambiente`).
- Alterações, e somente estas:
  1. declaração de `v_rc` (lista de `responsaveis_caso`);
  2. correção de `f_outro` para interpretar o responsável pelo caso.
- **Fora do escopo (não alterar):** `v_ra`, CTE `parc_dono`, `tav`, prévia, exportação, regras de elegibilidade, fidelização, retornos futuros, exclusões financeiras e responsáveis por acordo.

## 2. Motivo

Com `operador = CASO:<email>`, a prévia repassa `caso:<email>` ao universo. Na definição atual de produção, `f_outro` compara o dono da ficha com o texto inteiro (`caso:<email>`), então **nenhum aluno passa** e a tela mostra "Nenhum caso com esses filtros". A migration `20260927143351` contém o tratamento correto, mas a definição em produção não o contém.

## 3. MD5 (verificados)

| Momento | MD5 | Tamanho |
|---|---|---|
| Antes (produção, validada em leitura) | `88ec923f40294febcd4376491102b37d` | 11.345 caracteres |
| Depois (texto resultante, validado em leitura) | `7f791a02ddbfdf79d1e173e7e9660ce7` | +584 caracteres |

Verificações feitas em leitura: cada âncora ocorre exatamente 1 vez; o texto resultante tem `v_rc` 5 vezes, sem `parc_dono` e sem `v_ra`.

## 4. Pré-requisitos para execução controlada

1. Agente de Banco (Fase 2) disponível e liberado para escrita em produção. Hoje o Guardião bloqueia escrita de migration nesta fase.
2. Autorização nominal explícita da responsável, identificando projeto, MD5 e escopo. Autorização técnica para preparar **não** vale para executar.
3. Confirmação, por leitura, de que `ahattpqrjmhkzsmnbdzs` é o banco de produção do CRM.
4. Função sem alteração desde a validação: a guarda de MD5 do bloco aborta caso contrário.

## 5. SQL de aplicação (bloco único, transacional — NÃO executado)

```sql
BEGIN;

-- 0. Guarda: a função precisa estar exatamente como validada
DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo')
     <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Definição mudou desde a validação. Abortando.';
  END IF;
END $g$;

-- 1. Backup (sem IF NOT EXISTS: nunca sobrescreve backup anterior)
CREATE TABLE internal.bkp_acoes_massivas_universo_20261105 AS
SELECT now() AS salvo_em, md5(pg_get_functiondef(p.oid)) AS md5_def, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo';

DO $b$
BEGIN
  IF (SELECT md5_def FROM internal.bkp_acoes_massivas_universo_20261105) <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Backup não confere com a md5 validada. Abortando.';
  END IF;
END $b$;

-- 2. Snapshots de referência (mesma transação, antes da alteração)
CREATE TEMP TABLE pre_livres AS
SELECT aluno_id, coalesce(motivo,'(ok)') AS motivo, disponivel
  FROM public.acoes_massivas_universo('{"operador":"livres","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb);
CREATE TEMP TABLE pre_todos AS
SELECT aluno_id, coalesce(motivo,'(ok)') AS motivo, disponivel
  FROM public.acoes_massivas_universo('{"operador":"todos","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb);

-- 3. As duas alterações autorizadas (e somente elas)
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$a1$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');$a1$,
$n1$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');
  v_rc text[] := case when jsonb_typeof(f->'responsaveis_caso') = 'array'
                      then nullif(array(select lower(btrim(x))
                                          from jsonb_array_elements_text(f->'responsaveis_caso') x
                                         where nullif(btrim(x),'') is not null), '{}'::text[]) end;$n1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$a4$           case when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$a4$,
$n4$           case
                when v_rc is not null then not (
                  lower(coalesce(k.resp,'')) = any(v_rc)
                  or (nullif(btrim(coalesce(k.resp,'')),'') is null
                      and 'sem_responsavel' = any(v_rc)))
                when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$n4$, 1);

-- 4. Verificações: qualquer falha desfaz tudo
DO $t$
DECLARE
  v_md5  text;
  v_dono text;
  v_base int;
  v_diff int;
BEGIN
  -- 4a. MD5 final obrigatório
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo';
  IF v_md5 <> '7f791a02ddbfdf79d1e173e7e9660ce7' THEN
    RAISE EXCEPTION 'MD5 final % diferente do validado. Abortando.', v_md5;
  END IF;

  -- 4b. Responsável válido para o teste (sem número fixo)
  SELECT lower(c.operador_email) INTO v_dono
    FROM public.casos c WHERE c.operador_email IS NOT NULL
   GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
  IF v_dono IS NULL THEN
    RAISE EXCEPTION 'Nenhum responsável válido encontrado para o teste. Abortando.';
  END IF;
  SELECT count(*) INTO v_base
    FROM public.acoes_massivas_universo(jsonb_build_object('operador', v_dono, 'tipo_cobranca', 'MENSALIDADES_E_ACORDOS'))
   WHERE disponivel;
  IF v_base = 0 THEN
    RAISE EXCEPTION 'Responsável % sem alunos elegíveis: teste não conclusivo. Abortando.', v_dono;
  END IF;

  -- 4c. CASO:<dono> x e-mail simples, nos dois sentidos, por aluno/motivo/disponibilidade
  SELECT count(*) INTO v_diff FROM (
    (SELECT aluno_id, coalesce(motivo,'(ok)') AS motivo, disponivel
       FROM public.acoes_massivas_universo(jsonb_build_object('operador','caso:'||v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS'))
     EXCEPT ALL
     SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo(jsonb_build_object('operador', v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS')))
    UNION ALL
    (SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo(jsonb_build_object('operador', v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS'))
     EXCEPT ALL
     SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo(jsonb_build_object('operador','caso:'||v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS')))
  ) d;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'CASO e e-mail simples divergem em % linha(s). Abortando.', v_diff;
  END IF;

  -- 4d. CASO não traz aluno de outro responsável
  IF EXISTS (
    SELECT 1 FROM public.acoes_massivas_universo(jsonb_build_object('operador','caso:'||v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS')) u
     WHERE u.disponivel AND lower(coalesce(u.responsavel_email,'')) <> v_dono
  ) THEN
    RAISE EXCEPTION 'CASO trouxe aluno de outro responsável. Abortando.';
  END IF;

  -- 4e. livres e todos iguais ao snapshot anterior, nos dois sentidos
  SELECT count(*) INTO v_diff FROM (
    (SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo('{"operador":"livres","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb)
     EXCEPT ALL SELECT * FROM pre_livres)
    UNION ALL
    (SELECT * FROM pre_livres
     EXCEPT ALL
     SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo('{"operador":"livres","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb))
  ) d;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'livres mudou em % linha(s). Abortando.', v_diff; END IF;

  SELECT count(*) INTO v_diff FROM (
    (SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo('{"operador":"todos","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb)
     EXCEPT ALL SELECT * FROM pre_todos)
    UNION ALL
    (SELECT * FROM pre_todos
     EXCEPT ALL
     SELECT aluno_id, coalesce(motivo,'(ok)'), disponivel
       FROM public.acoes_massivas_universo('{"operador":"todos","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb))
  ) d;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'todos mudou em % linha(s). Abortando.', v_diff; END IF;
END $t$;

COMMIT;
```

## 6. Rollback protegido (NÃO executado)

Só restaura se a função ainda estiver no MD5 pós-aplicação. Se houve alteração posterior, aborta sem tocar em nada.

```sql
BEGIN;
DO $r$
DECLARE v_md5 text; v_def text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo';
  IF v_md5 <> '7f791a02ddbfdf79d1e173e7e9660ce7' THEN
    RAISE EXCEPTION 'Função mudou após a aplicação (md5 %). Rollback NÃO executado para não sobrescrever alterações posteriores.', v_md5;
  END IF;

  SELECT def INTO v_def FROM internal.bkp_acoes_massivas_universo_20261105;
  IF md5(v_def) <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Backup corrompido. Abortando.';
  END IF;

  EXECUTE v_def;

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo';
  IF v_md5 <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Rollback não reproduziu a md5 original. Abortando.';
  END IF;
END $r$;
COMMIT;
```

## 7. Limites da validação feita

- MD5 antes e depois e a presença das âncoras foram verificados em leitura.
- Compilação da função e as verificações 4a–4e só se confirmam na execução; qualquer falha desfaz a transação inteira.
- Números de carteira mudam: as verificações comparam caminhos no mesmo momento, sem valores fixos.

## 8. Status

Preparado e preservado para o agente de Banco (Fase 2). Não há execução, migration, merge ou deploy associados a este arquivo.
