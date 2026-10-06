-- carteira_academico_universo: tira o LATERAL e adianta os filtros do titulo.
--
-- POR QUE. A tela da Efetividade perdia o bloco "Alunos por status" em 2024 e
-- 2025. A causa nao era dado faltando -- a RPC tem 15 categorias nos dois anos --
-- era TEMPO: `authenticated` tem statement_timeout de 8s e a primeira chamada,
-- com cache frio, media 10,1 s a 27,9 s em 2024. Morna cai para ~1,4 s, por isso
-- o defeito aparecia e sumia.
--
-- ONDE ESTAVA O CUSTO. O ramo de 2024/2025 monta a CTE `t` sobre a base inteira
-- de graduacao e pos -- 47.231 titulos -- e para CADA linha sonda duas tabelas de
-- 400 mil linhas por LATERAL com `limit 1`. Medido: 188.771 + 173.756 buffers so
-- nessas duas sondagens, com 32.063 heap fetches no prime_extrato.
--
-- AS DUAS MUDANCAS, as duas provadas sem efeito no resultado:
--
--   1. LATERAL vira juncao simples. `boleto` e UNICO em prime_titulo_semestre e
--      em prime_extrato (400.693 e 400.765 linhas para o mesmo numero de boletos
--      distintos, zero repetidos, conferido em 06/10/2026). Com chave unica o
--      `limit 1` nunca descarta nada, entao a juncao simples devolve as mesmas
--      linhas -- e o planejador fica livre para escolher hash.
--
--   2. Cinco filtros sobem de `cand` para `t`. Sao predicados da PROPRIA linha de
--      acordos_titulos (situacao, status, acordo_id, origem_liquidacao, saldo),
--      que `cand` ja aplicava logo abaixo. Subi-los NAO mexe em `devido_total`:
--      a janela `sum(saldo) over (partition by aluno_id)` e calculada sobre
--      `cand`, depois do WHERE, e `cand` continua com exatamente o mesmo
--      conjunto de linhas. Tira 9.505 titulos de cima das juncoes: 47.231 ->
--      37.726.
--
-- O QUE NAO MUDA: o recorte, a regra academica, a classificacao financeira, o
-- ramo de 2026/1, o ramo de 2026/2 e o `else` que devolve vazio. Nenhuma linha
-- de dado e escrita.
--
-- PROVA DE EQUIVALENCIA, feita em producao em 06/10/2026 contra a funcao em
-- vigor, com a versao nova inline:
--   2024  atual 1.976 | novo 1.976 | so no atual 0 | so no novo 0
--         md5 do conjunto de CPFs: 79479f653190fad9cd5eb2cca76bd6e1 nos DOIS
--   2025  atual 2.881 | novo 2.881 | so no atual 0 | so no novo 0
--         md5 do conjunto de CPFs: ec2dd630cd032f85345e597c789922b0 nos DOIS
--
-- PATCH ANCORADO, nao reescrita: o corpo tem `regexp_replace(..., '\D', ...)` em
-- sete lugares, e retypar contrabarra em migration ja chegou dobrada ao banco
-- neste projeto. Aqui o corpo em vigor e LIDO e so os dois trechos trocam.

do $$
declare
  v_def  text;
  v_novo text;
  v_a1   text;
  v_b1   text;
  v_a2   text;
  v_b2   text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'carteira_academico_universo';
  if v_def is null then
    raise exception 'carteira_academico_universo nao existe';
  end if;

  -- Indentacao EXATA do corpo em vigor (10 espacos no `left join`, 31 na
  -- continuacao), conferida linha a linha contra pg_get_functiondef em
  -- 06/10/2026. Uma ancora com espacamento aproximado casa zero vezes e a
  -- migration aborta -- que e o comportamento certo, mas inutil.
  v_a1 := '          left join lateral (select s.semestre, s.carrier_id, s.liquidado_em, s.coletado_em, s.boleto' || E'\n'
       || '                               from public.prime_titulo_semestre s where s.boleto = tt.documento limit 1) ts on true' || E'\n'
       || '          left join lateral (select e.portador, e.liquidado_em, e.coletado_em, e.boleto' || E'\n'
       || '                               from public.prime_extrato e where e.boleto = tt.documento limit 1) ex on true';

  v_b1 := '          left join public.prime_titulo_semestre ts on ts.boleto = tt.documento' || E'\n'
       || '          left join public.prime_extrato ex on ex.boleto = tt.documento';

  v_a2 := '         and (tt.tipo_boleto ilike ''Cursos de Gradua%'' or tt.tipo_boleto ilike ''Cursos de P%s Gradua%'')' || E'\n'
       || '      ),';

  v_b2 := '         and (tt.tipo_boleto ilike ''Cursos de Gradua%'' or tt.tipo_boleto ilike ''Cursos de P%s Gradua%'')' || E'\n'
       || '         and upper(coalesce(tt.situacao,'''')) = ''ABERTO''' || E'\n'
       || '         and lower(coalesce(tt.status,'''')) = ''em_aberto''' || E'\n'
       || '         and tt.acordo_id is null' || E'\n'
       || '         and tt.origem_liquidacao is null' || E'\n'
       || '         and coalesce(tt.valor_cobranca_ajustado, tt.saldo_corrigido, tt.valor_em_aberto, tt.valor_original, 0) > 0' || E'\n'
       || '      ),';

  -- IDEMPOTENCIA PELO TEXTO NOVO: se os dois trechos novos ja estao la, a
  -- migration ja rodou e nao ha o que fazer.
  if position(v_b1 in v_def) > 0 and position(v_b2 in v_def) > 0 then
    raise notice 'carteira_academico_universo ja esta na versao sem LATERAL; nada a fazer';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_a1, ''))) / nullif(length(v_a1),0) <> 1 then
    raise exception 'ancora 1 (os dois LATERAL) nao aparece exatamente uma vez -- a funcao mudou, revisar antes';
  end if;
  if (length(v_def) - length(replace(v_def, v_a2, ''))) / nullif(length(v_a2),0) <> 1 then
    raise exception 'ancora 2 (fim do WHERE da CTE t) nao aparece exatamente uma vez -- a funcao mudou, revisar antes';
  end if;

  v_novo := replace(v_def, v_a1, v_b1);
  v_novo := replace(v_novo, v_a2, v_b2);

  if v_novo = v_def then
    raise exception 'o patch nao alterou nada -- abortando em vez de reaplicar o corpo igual';
  end if;

  execute v_novo;
  raise notice 'carteira_academico_universo: LATERAL removido e 5 filtros adiantados';
end $$;
