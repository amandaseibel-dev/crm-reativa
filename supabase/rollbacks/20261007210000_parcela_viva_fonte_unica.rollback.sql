-- ROLLBACK de 20261007210000_parcela_viva_fonte_unica.
--
-- APLICAR DEPOIS do rollback de 20261007211500 (a regra), nunca antes: a regra
-- depende desta funcao. Rodar fora de ordem deixa as funcoes da regra
-- chamando `parcela_viva()`, que teria sido removida.
--
-- LIMITACAO QUE PRECISA ESTAR ESCRITA: este rollback NAO restaura o texto
-- ORIGINAL de cada um dos 46 pontos. Ele devolve a lista CANONICA
--
--     upper(coalesce(X,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
--
-- em todos eles. As 5 variantes de vocabulario que existiam (umas com 'PAGA',
-- outras com menos valores) sao colapsadas numa so.
--
-- POR QUE ISSO E ACEITAVEL, e exatamente em que sentido: a migration provou --
-- e a prova esta repetida no proprio arquivo dela, como asseguracao que aborta
-- a aplicacao se falhar -- que as 5 variantes classificam EXATAMENTE o mesmo
-- conjunto de status reais como cobravel. Entao o rollback e equivalente em
-- COMPORTAMENTO, e divergente em TEXTO. Nenhuma parcela muda de classificacao.
--
-- O que se perde e a informacao historica de qual variante cada ponto usava --
-- que e justamente a divida que a migration veio pagar. Se a intencao for
-- voltar byte a byte, o caminho nao e este arquivo: e restaurar cada funcao a
-- partir de `supabase_migrations.schema_migrations`, onde o SQL que criou cada
-- uma esta gravado.

-- ---------------------------------------------------------------------------
-- 1. DESFAZ O PATCH: parcela_viva(X) volta a ser lista literal
-- ---------------------------------------------------------------------------
do $reverter$
declare
  r record;
  v_novo text;
  v_trocas int;
  v_total int := 0;
  v_fn int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname <> 'parcela_viva'
       and pg_get_functiondef(p.oid) ~ 'public\.parcela_viva\s*\('
     order by p.proname, p.oid
  loop
    select count(*) into v_trocas
      from regexp_matches(r.def, 'public\.parcela_viva\s*\(\s*([^()]+?)\s*\)', 'g');

    if v_trocas = 0 then
      continue;
    end if;

    v_novo := regexp_replace(r.def,
      'public\.parcela_viva\s*\(\s*([^()]+?)\s*\)',
      'upper(coalesce(\1,'''')) not in (''PAGO'',''CANCELADA'',''CANCELADO'',''ESTORNADA'',''ESTORNADO'')',
      'g');

    -- O reverso ALONGA o corpo (lista literal e maior que a chamada). Se
    -- encurtou, casou errado.
    if length(v_novo) <= length(r.def) then
      raise exception 'rollback parcela_viva: reversao em %() nao alongou o corpo. Abortado.', r.proname;
    end if;

    execute v_novo;
    v_total := v_total + v_trocas;
    v_fn := v_fn + 1;
    raise notice 'rollback parcela_viva: %() -- % reversao(oes)', r.proname, v_trocas;
  end loop;

  -- ESTRUTURAL: nao pode sobrar nenhuma chamada.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'parcela_viva'
       and pg_get_functiondef(p.oid) ~ 'public\.parcela_viva\s*\(') then
    raise exception 'rollback parcela_viva: sobrou chamada a parcela_viva em alguma funcao. Reversao parcial -- abortado.';
  end if;

  raise notice 'rollback parcela_viva: % reversao(oes) em % funcao(oes).', v_total, v_fn;
end
$reverter$;

-- ---------------------------------------------------------------------------
-- 2. REMOVE A FONTE UNICA
-- ---------------------------------------------------------------------------
-- Sem CASCADE de proposito: se alguma coisa ainda depender dela, o DROP falha e
-- avisa, em vez de levar a dependencia junto em silencio.
drop function if exists public.parcela_viva(text);
