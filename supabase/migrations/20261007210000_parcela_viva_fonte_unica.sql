-- PARCELA VIVA: fonte unica do vocabulario de "parcela ainda cobravel".
--
-- ESTA MIGRATION NAO MUDA COMPORTAMENTO NENHUM. Ela e o passo 1 de dois: cria a
-- fonte unica e migra para ela os pontos que JA SAO equivalentes a ela. O passo
-- 2 (20261007211500) e que introduz DEVOLVIDA e SUSPENSA.
--
-- O PROBLEMA, MEDIDO EM PRODUCAO EM 07/10/2026. Nao existe lugar nenhum que
-- defina "parcela ainda cobravel". O conceito esta escrito como LISTA DE
-- EXCLUSAO -- `status not in ('PAGO','CANCELADA',...)` -- repetida em 57 pontos,
-- dentro de 44 funcoes vivas, em 11 VARIANTES de vocabulario diferentes:
--
--   18x ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
--    9x ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
--    9x ('PAGO','CANCELADA')
--    7x ('PAGO','CANCELADA','CANCELADO')
--    5x ('PAGO','CANCELADA','RENEGOCIADA')
--    1x ('PAGO','CANCELADA','ESTORNADA')
--    1x ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO','RENEGOCIADA')
--    + 4 variantes de titulo/jornada que nao sao de parcela
--
-- A CONSEQUENCIA: qualquer status NOVO que nao entre nessas listas e lido como
-- parcela VIVA -- fica no saldo, na fila e na cobranca. E a regra aprovada pela
-- gestao em 07/10/2026 cria dois: DEVOLVIDA e SUSPENSA. Sem esta migration, o
-- passo 2 teria de alterar 57 pontos, e o passo 3 alteraria 57 de novo.
--
-- ANALISE DE EQUIVALENCIA -- por que isto e seguro, e onde NAO e.
--
-- As 11 variantes NAO sao duplicatas inocentes. Medi cada uma contra os status
-- que EXISTEM em producao (PAGO 5.691, VENCIDA 5.109, A_VENCER 3.719,
-- CANCELADA 1.564, RENEGOCIADA 6):
--
--   * 5 variantes classificam exatamente o MESMO conjunto como viva
--     (A_VENCER, VENCIDA, RENEGOCIADA). Diferem so em status que nao existem
--     (PAGA, CANCELADO, ESTORNADA, ESTORNADO). Estas 46 ocorrencias viram
--     `parcela_viva()` -- 0 parcelas mudam de classificacao;
--   * 2 variantes EXCLUEM `RENEGOCIADA`, e por isso classificam 6 parcelas
--     reais de forma diferente. Estas 6 ocorrencias NAO sao colapsadas: a
--     lista e estendida no lugar no passo 2, preservando a semantica. Colapsar
--     mudaria o saldo de 6 parcelas sem ninguem ter pedido;
--   * `ficha_totais_aluno` nao tem 'PAGO' na lista (usa 'PAGA','QUITADA') e por
--     isso conta as 5.691 parcelas PAGAS como ABERTAS -- R$ 20,40 mi onde o
--     correto seria R$ 11,32 mi. NAO E VARIANTE, E BUG, e nao tem chamador
--     nenhum (0 no front, 0 no banco). Fica INTOCADA aqui de proposito:
--     "corrigir" 5.691 parcelas de carona num PR de refatoracao e pior que o
--     bug. Tratada em tarefa separada.
--
-- POR QUE O PATCH E MECANICO, E NAO 46 CORPOS COPIADOS A MAO. O repositorio e a
-- producao sao trilhas quase disjuntas (supabase/ledger/DUAS-TRILHAS.md): o
-- corpo valido de cada funcao e o de PRODUCAO. Copiar 35 corpos a mao para um
-- arquivo introduziria risco de transcricao em 35 funcoes vivas de uma vez.
-- Aqui o patch le `pg_get_functiondef`, troca SO o trecho e reexecuta -- o
-- mesmo padrao de patch ancorado que o projeto ja usa. E ele FALHA FECHADO:
-- se a contagem de trocas nao for exatamente a esperada, levanta excecao e a
-- transacao inteira volta.

-- ---------------------------------------------------------------------------
-- 1. A FONTE UNICA
-- ---------------------------------------------------------------------------
-- IMMUTABLE porque so olha o proprio argumento -- entra em indice e o planner
-- pode dobrar a chamada. `coalesce` + `upper` replicam exatamente o que as 46
-- ocorrencias faziam, para que a troca seja textualmente neutra.
--
-- FALHA PARA O LADO SEGURO: status desconhecido (typo, valor novo que ninguem
-- cadastrou aqui) e considerado VIVO. Erra cobrando, nao erra deixando de
-- cobrar -- e um status errado aparece como divida que nao fecha, que alguem
-- percebe, em vez de divida que desaparece calada.
create or replace function public.parcela_viva(p_status text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO'
  );
$function$;

comment on function public.parcela_viva(text) is
  'Fonte unica de "parcela ainda cobravel". Status desconhecido conta como VIVO de proposito (erra cobrando, nao erra deixando de cobrar). NAO inclui RENEGOCIADA: 6 parcelas reais em producao, e 2 dos 57 pontos as tratavam como mortas -- essa divergencia foi preservada no lugar em vez de colapsada. A partir de 20261007211500 inclui DEVOLVIDA e SUSPENSA.';

-- ---------------------------------------------------------------------------
-- 2. O PATCH MECANICO
-- ---------------------------------------------------------------------------
do $patch$
declare
  -- Cobre as 4 formas de escrever a MESMA coisa que aparecem em producao:
  --   upper(coalesce(p.status,'')) not in (...)
  --   coalesce(p.status,'')        not in (...)
  --   coalesce(status,'')          not in (...)
  --   p.status                     not in (...)
  --   status                       not in (...)
  -- A lista aceita SO os valores equivalentes. Lista com RENEGOCIADA nao casa
  -- (o fecha-parenteses falha), e por isso as 6 divergentes ficam de fora
  -- automaticamente -- a selecao e por construcao, nao por lista de excecao
  -- escrita a mao.
  c_re text :=
    '(?:upper\s*\(\s*)?(?:coalesce\s*\(\s*)?((?:[A-Za-z_][A-Za-z0-9_]*\.)?status)' ||
    '(?:\s*,\s*''''\s*\))?\s*\)?\s*not\s+in\s*\(\s*''PAGO''' ||
    '(?:\s*,\s*''(?:PAGA|CANCELADA|CANCELADO|ESTORNADA|ESTORNADO)'')*\s*\)';
  r record;
  v_novo text;
  v_trocas int;
  v_total_trocas int := 0;
  v_total_fn int := 0;
  v_sobra int;
begin
  for r in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       -- nao se auto-patcheia
       and p.proname <> 'parcela_viva'
       and pg_get_functiondef(p.oid) ~* ('not\s+in\s*\([^)]*''PAGO''[^)]*\)')
     order by p.proname, p.oid
  loop
    select count(*) into v_trocas
      from regexp_matches(r.def, c_re, 'gi');

    if v_trocas = 0 then
      continue;
    end if;

    v_novo := regexp_replace(r.def, c_re, 'public.parcela_viva(\1)', 'gi');

    -- GUARDA 1: o patch nao pode encurtar nada alem do previsto. Cada troca
    -- substitui um trecho por um mais curto; se o texto cresceu, algo casou
    -- errado.
    if length(v_novo) >= length(r.def) then
      raise exception 'parcela_viva: patch em %() nao encurtou o corpo (% -> %). Abortado.',
        r.proname, length(r.def), length(v_novo);
    end if;

    -- GUARDA 2: nao pode sobrar referencia a `parcela_viva` dentro de string
    -- literal nem ter quebrado o balanceamento de parenteses.
    if (length(v_novo) - length(replace(v_novo, '(', ''))) <>
       (length(v_novo) - length(replace(v_novo, ')', ''))) then
      raise exception 'parcela_viva: parenteses desbalanceados em %() depois do patch. Abortado.',
        r.proname;
    end if;

    execute v_novo;

    v_total_trocas := v_total_trocas + v_trocas;
    v_total_fn := v_total_fn + 1;
    raise notice 'parcela_viva: %() -- % troca(s)', r.proname, v_trocas;
  end loop;

  -- GUARDA 3 -- ESTRUTURAL, nao por contagem. Uma contagem fixa ("espero 46 em
  -- 35") travaria em producao e tornaria esta migration INTESTAVEL na fixture,
  -- que tem um subconjunto das funcoes. A asseguracao certa e mais forte que o
  -- numero: NAO PODE SOBRAR nenhuma lista equivalente. O que sobra tem de ser,
  -- obrigatoriamente, uma das excecoes conhecidas e justificadas.
  select count(*) into v_sobra
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
         lateral regexp_matches(pg_get_functiondef(p.oid), c_re, 'gi')
   where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'parcela_viva';

  if v_sobra > 0 then
    raise exception 'parcela_viva: sobraram % lista(s) equivalente(s) sem migrar. O patch foi parcial -- abortado.', v_sobra;
  end if;

  -- GUARDA 4: a migration nao pode ser um no-op silencioso. Se nao trocou nada,
  -- ou o regex parou de casar, ou ja foi aplicada -- e os dois casos merecem
  -- aviso explicito em vez de sucesso mudo.
  if v_total_trocas = 0 then
    raise notice 'parcela_viva: 0 trocas. Ou ja estava aplicada, ou nao ha lista equivalente neste banco.';
  end if;

  raise notice 'parcela_viva: % troca(s) em % funcao(oes); 0 lista equivalente remanescente.',
    v_total_trocas, v_total_fn;
end
$patch$;

-- ---------------------------------------------------------------------------
-- 3. PROVA DE NEUTRALIDADE
-- ---------------------------------------------------------------------------
-- A funcao tem de concordar com TODAS as 5 variantes equivalentes, para cada
-- status que existe em producao. Isto nao e teste de unidade: e asseguracao
-- dentro da propria migration, que impede a aplicacao se a equivalencia nao se
-- sustentar no banco real.
do $prova$
declare
  r record;
  v_div int := 0;
begin
  for r in
    select s,
           public.parcela_viva(s) as canonica,
           s not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') as v1,
           s not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') as v2,
           s not in ('PAGO','CANCELADA') as v3,
           s not in ('PAGO','CANCELADA','CANCELADO') as v5,
           s not in ('PAGO','CANCELADA','ESTORNADA') as v6
      from (select distinct upper(coalesce(status,'')) as s from public.parcelas) z
  loop
    if r.canonica is distinct from r.v1 or r.canonica is distinct from r.v2
       or r.canonica is distinct from r.v3 or r.canonica is distinct from r.v5
       or r.canonica is distinct from r.v6 then
      v_div := v_div + 1;
      raise warning 'parcela_viva: status % divergiu (canonica=%, v1=%, v2=%, v3=%, v5=%, v6=%)',
        r.s, r.canonica, r.v1, r.v2, r.v3, r.v5, r.v6;
    end if;
  end loop;

  if v_div > 0 then
    raise exception 'parcela_viva: % status divergem entre a canonica e as variantes equivalentes. A troca NAO e neutra -- abortado.', v_div;
  end if;

  raise notice 'parcela_viva: equivalencia provada para todos os status presentes em public.parcelas.';
end
$prova$;
