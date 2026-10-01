-- ---------------------------------------------------------------------------
-- Acoes Massivas: filtro de responsavel em DUAS dimensoes independentes.
--
-- O QUE A INVESTIGACAO ACHOU (leitura de producao, 27/09/2026)
--
-- 1. NENHUMA das 24 funcoes de acoes massivas consulta
--    acordos.operador_responsavel_email. O dono do ACORDO nunca foi olhado.
--    acoes_massivas_tipo_cobranca_alunos le public.acordos SEM filtro de dono.
--
-- 2. O recorte de responsavel e por DONO DA FICHA
--    (alunos.responsavel_atual_email), nao por casos.operador_email. As duas
--    costumam andar juntas por gatilho, mas ja se viu divergir.
--
-- 3. Por isso, "Acordos vencidos" filtrado por um operador aciona tambem
--    acordo de OUTRA pessoa. Medido, por dono de caso, entre alunos com acordo
--    vencido:
--      Carteira Geral 243 alunos / 136 acordos de outro dono (7 terceiros)
--      cobranca11     212 / 117 (7)    cobranca13 193 / 116 (8)
--      cobranca06     206 / 112 (9)    cobranca10 234 / 106 (9)
--      cobranca12     194 / 103 (9)    cobranca08 227 /  96 (8)
--      cobranca05     234 /  92 (8)    fila livre  13 /  13 (6)
--    ~902 acordos de terceiros que hoje entrariam.
--
-- 4. acoes_massivas_filtros() so lista `ativo and perfil='operador'`. Olga
--    (inativa), a gestora (gerencia), Fernanda (supervisor), a ADM
--    (administrativo) e a Carteira Geral (carteira) nao apareciam no filtro,
--    embora tenham caso e/ou acordo.
--
-- 5. JA EXISTIA um "todos" generico: v_op='todos' desliga o recorte por
--    completo (`case when v_op = 'todos' then false ... end as f_outro`), e a
--    tela o oferece como "Todos os operadores". Esta migration NAO cria um
--    TODOS novo; a selecao explicita tem precedencia sobre ele.
--
-- O QUE MUDA
--   a) acoes_massivas_responsaveis(): quem TEM caso ou acordo, com contagem das
--      duas dimensoes e a classe (operador ativo, inativo, nao-operador,
--      Carteira Geral, sem responsavel).
--   b) o universo aceita duas listas independentes:
--        responsaveis_caso   -> dono da FICHA
--        responsaveis_acordo -> dono do ACORDO
--      Ausentes, o comportamento e exatamente o de hoje (v_op).
--   c) a previa recebe as duas listas por p_operador_email com sintaxe estrita
--      'CASO:a@x|b@x;ACORDO:c@x|SEM_RESPONSAVEL' e devolve `por_responsavel`
--      com alunos, casos, acordos, acordos de outro dono e valor.
--
-- POR QUE A SINTAXE NO p_operador_email
-- acoes_massivas_previa tem 18 parametros escalares e monta o jsonb de filtros
-- internamente; nao ha por onde passar array sem mudar a assinatura de uma
-- funcao que dispara mensagem em massa. O codigo ja usa o idioma de lista em
-- texto ('2025|2026' em ano, unidade e situacao_academica). A sintaxe e
-- validada com erro alto: nada ambiguo passa. Uma previa com entrada jsonb e a
-- forma certa no longo prazo e esta no backlog.
--
-- NADA aqui dispara acao: sao leitura e recorte.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

-- (a) QUEM PODE SER ESCOLHIDO ------------------------------------------------
create or replace function public.acoes_massivas_responsaveis()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: lista de responsaveis restrita a gestao.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'email', email, 'nome', nome, 'classe', classe,
           'casos', casos, 'acordos', acordos, 'acordos_ativos', acordos_ativos
         ) order by ord, (casos + acordos) desc, nome), '[]'::jsonb)
    into v_res
    from (
      -- sem responsavel: entra como sentinela, nunca como pessoa
      select 0 as ord, 'SEM_RESPONSAVEL' as email, 'Sem responsável' as nome,
             'SEM_RESPONSAVEL' as classe,
             (select count(*) from public.casos c
               where nullif(btrim(coalesce(c.operador_email,'')),'') is null
                 and not coalesce(c.encerrado_operacional,false))::int as casos,
             (select count(*) from public.acordos a
               where nullif(btrim(coalesce(a.operador_responsavel_email,'')),'') is null)::int as acordos,
             (select count(*) from public.acordos a
               where nullif(btrim(coalesce(a.operador_responsavel_email,'')),'') is null
                 and upper(coalesce(a.status,'')) = 'ATIVO')::int as acordos_ativos
      union all
      -- todo mundo que TEM caso ou acordo, venha ou nao de `usuarios`
      select 1, q.email,
             coalesce(u.nome, q.email),
             case
               when q.email = internal.carteira_geral_email()        then 'CARTEIRA_GERAL'
               when u.email is null                                   then 'FORA_DE_USUARIOS'
               when not u.ativo                                       then 'INATIVO'
               when u.perfil <> 'operador'                            then 'NAO_OPERADOR'
               else 'OPERADOR_ATIVO'
             end,
             q.casos, q.acordos, q.acordos_ativos
        from (
          select e as email,
                 (select count(*) from public.casos c
                   where lower(nullif(btrim(coalesce(c.operador_email,'')),'')) = e
                     and not coalesce(c.encerrado_operacional,false))::int as casos,
                 (select count(*) from public.acordos a
                   where lower(nullif(btrim(coalesce(a.operador_responsavel_email,'')),'')) = e)::int as acordos,
                 (select count(*) from public.acordos a
                   where lower(nullif(btrim(coalesce(a.operador_responsavel_email,'')),'')) = e
                     and upper(coalesce(a.status,'')) = 'ATIVO')::int as acordos_ativos
            from (
              select lower(nullif(btrim(coalesce(c.operador_email,'')),'')) as e
                from public.casos c where not coalesce(c.encerrado_operacional,false)
              union
              select lower(nullif(btrim(coalesce(a.operador_responsavel_email,'')),''))
                from public.acordos a
            ) z where z.e is not null
        ) q
        left join public.usuarios u on lower(u.email) = q.email
    ) w
   where w.casos > 0 or w.acordos > 0;

  return v_res;
end;
$fn$;

revoke all on function public.acoes_massivas_responsaveis() from public, anon;
grant execute on function public.acoes_massivas_responsaveis() to authenticated;

-- (b) O UNIVERSO ACEITA AS DUAS LISTAS ---------------------------------------
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');$ancora$,
$novo$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');
  -- DUAS DIMENSOES INDEPENDENTES. Ausentes (null), o comportamento e o de
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
                                         where nullif(btrim(x),'') is not null), '{}'::text[]) end;$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$  base as materialized ($ancora$,
$novo$  -- Acordo vencido CUJO RESPONSAVEL esta na selecao.
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
  base as materialized ($novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           coalesce(tc.tem_acordo_vencido, false) as tav$ancora$,
$novo$           -- com a dimensao de acordo em uso, "tem acordo vencido" passa a
           -- significar "tem acordo vencido DE QUEM EU SELECIONEI"
           (coalesce(tc.tem_acordo_vencido, false)
            and (v_ra is null
                 or exists (select 1 from parc_dono pd where pd.aluno_id = p.id))) as tav$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           case when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$ancora$,
$novo$           case
                -- A SELECAO EXPLICITA TEM PRECEDENCIA sobre v_op, inclusive
                -- sobre o 'todos' que ja existia. Quem manda e a lista.
                when v_rc is not null then not (
                  lower(coalesce(k.resp,'')) = any(v_rc)
                  or (nullif(btrim(coalesce(k.resp,'')),'') is null
                      and 'sem_responsavel' = any(v_rc)))
                when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$novo$,
  1);

-- (c) A PREVIA: le a selecao e devolve a quebra por responsavel --------------
--
-- SINTAXE (validada com erro alto):
--   'CASO:a@x|b@x'                         -> so a dimensao de caso
--   'CASO:a@x;ACORDO:c@x|SEM_RESPONSAVEL'  -> as duas
--   'a@x' / 'livres' / 'todos'             -> como antes, intocado
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$  v_op text := coalesce(lower(nullif(btrim(p_operador_email), '')), 'livres');$ancora$,
$novo$  v_op_raw text := coalesce(btrim(p_operador_email), '');
  v_tem_sel boolean := upper(coalesce(btrim(p_operador_email), '')) like 'CASO:%';
  -- dimensao CASO (dono da ficha): o trecho entre 'CASO:' e o ';'
  v_rc text[] := case when upper(coalesce(btrim(p_operador_email), '')) like 'CASO:%'
    then nullif(array(
      select lower(btrim(x)) from unnest(string_to_array(
        split_part(split_part(coalesce(btrim(p_operador_email), ''), ';', 1), ':', 2), '|')) x
       where nullif(btrim(x), '') is not null), '{}'::text[]) end;
  -- dimensao ACORDO (dono do acordo): o trecho depois de 'ACORDO:'
  v_ra text[] := case when position('ACORDO:' in upper(coalesce(btrim(p_operador_email), ''))) > 0
    then nullif(array(
      select lower(btrim(x)) from unnest(string_to_array(
        substring(coalesce(btrim(p_operador_email), '')
                  from position('ACORDO:' in upper(coalesce(btrim(p_operador_email), ''))) + 7), '|')) x
       where nullif(btrim(x), '') is not null), '{}'::text[]) end;
  -- o que volta em `operador_email`: a tela compara com o que mandou, e essa
  -- guarda continua valendo na sintaxe nova.
  v_op text := case when upper(coalesce(btrim(p_operador_email), '')) like 'CASO:%'
                    then lower(coalesce(btrim(p_operador_email), ''))
                    else coalesce(lower(nullif(btrim(p_operador_email), '')), 'livres') end;$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$  v_filtros := jsonb_strip_nulls(jsonb_build_object($ancora$,
$novo$  -- RECORTE EXPLICITO OBRIGATORIO na sintaxe nova: 'CASO:' sem nenhum e-mail
  -- disparia sobre a base inteira. Recusa alto em vez de assumir.
  if v_tem_sel and v_rc is null then
    raise exception 'Selecione ao menos um responsavel pelo caso -- "CASO:" veio vazio.'
      using errcode = '22023';
  end if;

  v_filtros := jsonb_strip_nulls(jsonb_build_object($novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$    'operador', v_op,$ancora$,
$novo$    'operador', v_op,
    'responsaveis_caso', case when v_rc is null then null else to_jsonb(v_rc) end,
    'responsaveis_acordo', case when v_ra is null then null else to_jsonb(v_ra) end,$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$    'operador_email', v_op,$ancora$,
$novo$    'operador_email', v_op,
    'responsaveis_caso', case when v_rc is null then null else to_jsonb(v_rc) end,
    'responsaveis_acordo', case when v_ra is null then null else to_jsonb(v_ra) end,
    -- A QUEBRA POR RESPONSAVEL, sobre os ELEGIVEIS -- e o que a gestao le antes
    -- de confirmar. `acordos_de_outro_dono` e o numero que faltava: acordo do
    -- aluno cujo responsavel NAO e o responsavel da linha.
    'por_responsavel', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'responsavel', r.resp,
               'alunos',  r.alunos,
               'valor',   r.valor,
               'casos',   (select count(*) from public.casos c
                            where c.aluno_id = any(r.ids)
                              and not coalesce(c.encerrado_operacional, false)),
               'acordos', (select count(*) from public.acordos a where a.aluno_id = any(r.ids)),
               'acordos_de_outro_dono', (select count(*) from public.acordos a
                                          where a.aluno_id = any(r.ids)
                                            and lower(coalesce(a.operador_responsavel_email, ''))
                                                is distinct from nullif(r.resp, 'SEM_RESPONSAVEL'))
             ) order by r.alunos desc), '[]'::jsonb)
        from (select coalesce(nullif(lower(btrim(coalesce(e.responsavel_email, ''))), ''), 'SEM_RESPONSAVEL') as resp,
                     count(*)::int as alunos,
                     round(coalesce(sum(e.valor), 0), 2) as valor,
                     array_agg(e.aluno_id) as ids
                from el e group by 1) r),$novo$,
  1);
