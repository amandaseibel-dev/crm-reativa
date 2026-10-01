-- Rollback de 20260927180000: desfaz as duas dimensoes de responsavel.
--
-- ATENCAO, o que reverter reintroduz:
--   1. o recorte volta a ser SO pelo dono da ficha, e "Acordos vencidos"
--      filtrado por um operador volta a acionar acordo de OUTRA pessoa
--      (~902 acordos, medido em 27/09/2026);
--   2. a tela publicada chama acoes_massivas_responsaveis e passa
--      'CASO:...;ACORDO:...' em p_operador_email. Sem estas funcoes, a lista de
--      responsaveis vem vazia (42883) e a previa passa a tratar o texto inteiro
--      como um e-mail -- recorte vazio, NENHUM aluno. Reverter so faz sentido
--      junto com a reversao do front.
--
-- Nenhum dado e movido aqui.

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$    'operador_email', v_op,
    'responsaveis_caso', case when v_rc is null then null else to_jsonb(v_rc) end,
    'responsaveis_acordo', case when v_ra is null then null else to_jsonb(v_ra) end,$ancora$,
$novo$    'operador_email', v_op,$novo$,
  1);

-- a quebra por responsavel sai junto. Ancora explicita: um bloco dinamico que
-- recorta o corpo por position() quebraria em silencio se o texto mudasse.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$    -- A QUEBRA POR RESPONSAVEL, sobre os ELEGIVEIS -- e o que a gestao le antes
    -- de confirmar. `acordos_de_outro_dono` e o numero que faltava: acordo do
    -- aluno cujo responsavel NAO e o responsavel da linha.
    'por_responsavel', ($ancora$,
$novo$    'por_responsavel_REMOVIDO', ($novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$    'operador', v_op,
    'responsaveis_caso', case when v_rc is null then null else to_jsonb(v_rc) end,
    'responsaveis_acordo', case when v_ra is null then null else to_jsonb(v_ra) end,$ancora$,
$novo$    'operador', v_op,$novo$,
  1);

drop function if exists public.acoes_massivas_responsaveis();

-- O universo volta ao texto de 20260920110000: as duas listas somem, o CTE
-- parc_dono some e f_outro volta a olhar so v_op. Os quatro trechos sao o
-- inverso exato dos quatro patches da ida.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           case
                -- A SELECAO EXPLICITA TEM PRECEDENCIA sobre v_op, inclusive
                -- sobre o 'todos' que ja existia. Quem manda e a lista.
                when v_rc is not null then not (
                  lower(coalesce(k.resp,'')) = any(v_rc)
                  or (nullif(btrim(coalesce(k.resp,'')),'') is null
                      and 'sem_responsavel' = any(v_rc)))
                when v_op = 'todos' then false$ancora$,
$novo$           case when v_op = 'todos' then false$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           -- com a dimensao de acordo em uso, "tem acordo vencido" passa a
           -- significar "tem acordo vencido DE QUEM EU SELECIONEI"
           (coalesce(tc.tem_acordo_vencido, false)
            and (v_ra is null
                 or exists (select 1 from parc_dono pd where pd.aluno_id = p.id))) as tav$ancora$,
$novo$           coalesce(tc.tem_acordo_vencido, false) as tav$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$  -- Acordo vencido CUJO RESPONSAVEL esta na selecao.
  -- Existe separado de `parc` de proposito: `parc` define o universo e o ano, e
  -- recortar ali tiraria da base quem tem MENSALIDADE e, por acaso, um acordo
  -- de terceiro. Aqui se recorta so o flag "tem acordo vencido", que e o que a
  -- modalidade de acordo usa.
  parc_dono as materialized (
    select distinct a.aluno_id
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where a.status = 'ATIVO' and p.status = 'VENCIDA'
       and (v_ids is null or a.aluno_id = any(v_ids))
       and (v_ra is null
            or lower(coalesce(a.operador_responsavel_email,'')) = any(v_ra)
            or (nullif(btrim(coalesce(a.operador_responsavel_email,'')),'') is null
                and 'sem_responsavel' = any(v_ra)))
  ),
  base as materialized ($ancora$,
$novo$  base as materialized ($novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$  -- DUAS DIMENSOES INDEPENDENTES. Ausentes (null), o comportamento e o de
  -- v_op -- nenhuma chamada antiga muda de resultado.
  --   responsaveis_caso   -> dono da FICHA  (alunos.responsavel_atual_email)
  --   responsaveis_acordo -> dono do ACORDO (acordos.operador_responsavel_email)
  -- Sentinela 'sem_responsavel' = sem dono.
  v_rc text[] := case when jsonb_typeof(f->'responsaveis_caso') = 'array'
                      then nullif(array(select lower(btrim(x))
                                          from jsonb_array_elements_text(f->'responsaveis_caso') x
                                         where nullif(btrim(x),'') is not null), '{}'::text[]) end;
  v_ra text[] := case when jsonb_typeof(f->'responsaveis_acordo') = 'array'
                      then nullif(array(select lower(btrim(x))
                                          from jsonb_array_elements_text(f->'responsaveis_acordo') x
                                         where nullif(btrim(x),'') is not null), '{}'::text[]) end;$ancora$,
$novo$$novo$,
  1);
