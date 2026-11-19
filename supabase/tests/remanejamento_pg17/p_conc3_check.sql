-- CONTENCAO B4, veredito (independe da ordem de termino; vale para as duas variantes):
--  (1) uma movimentacao ocupa a vaga: a soma de alunos_movidos e 1; a outra recusada;
--  (2) o destino ficou exatamente no teto (3) e nao passou;
--  (3) exatamente um dos dois alunos esta com a Luana, o outro na carteira;
--  (4) SOBREPOSICAO comprovada: a sessao que nao segurou o lock iniciou com o lock tomado pelo titular e so
--      terminou depois do COMMIT dele (inicio_outro < commit_titular <= fim_outro, e a espera passou de 1,5 s).
--  O titular do lock e lido da flag: o veredito vale para as duas ordens.
\i lib.sql
do $$
declare holder text; other text; rp jsonb; rs jsonb; ip timestamptz; fp timestamptz; isg timestamptz; fsg timestamptz; commit_p timestamptz;
  v_luana int; v_x text; v_y text; mov_p int; mov_s int; xid uuid; yid uuid;
begin
  select substring(nome from 8) into holder from public.cg_teste3_flag where nome like 'holder:%';
  other := case when holder = 'primeiro' then 'segundo' else 'primeiro' end;
  select resultado, inicio, fim into rp, ip, fp from public.cg_teste3_res where sessao = holder;
  select resultado, inicio, fim into rs, isg, fsg from public.cg_teste3_res where sessao = other;
  select ts into commit_p from public.cg_teste3_flag where nome = 'commit_holder';
  perform pg_temp.afirma(holder is not null, 'contencao: titular do lock identificado (' || coalesce(holder,'-') || ')');
  perform pg_temp.afirma(rp is not null and rs is not null, 'contencao: as duas sessoes registraram resultado');
  perform pg_temp.afirma(commit_p is not null, 'contencao: commit do titular registrado');
  mov_p := (rp->>'alunos_movidos')::int; mov_s := (rs->>'alunos_movidos')::int;
  perform pg_temp.afirma(mov_p + mov_s = 1,
    format('contencao: UMA movimentacao ocupa a vaga (titular=%s, outro=%s)', mov_p, mov_s));
  perform pg_temp.afirma(coalesce((rp->>'total_recusados')::int,0) + coalesce((rs->>'total_recusados')::int,0) = 1,
    'contencao: a outra sessao foi recusada pela capacidade (registrado em recusados)');
  select count(*) into v_luana from public.casos where operador_email = 'cobranca05@aelbra.com.br' and not coalesce(encerrado_operacional,false);
  perform pg_temp.afirma(v_luana = 3, format('contencao: destino no teto exato 3 (ocupacao=%s, nao passou)', v_luana));
  select aluno into xid from public.cg_teste3_ids where nome = 'X';
  select aluno into yid from public.cg_teste3_ids where nome = 'Y';
  select responsavel_atual_email into v_x from public.alunos where id = xid;
  select responsavel_atual_email into v_y from public.alunos where id = yid;
  perform pg_temp.afirma((v_x = 'cobranca05@aelbra.com.br') <> (v_y = 'cobranca05@aelbra.com.br'),
    format('contencao: exatamente um aluno com a Luana (X=%s, Y=%s)', v_x, v_y));
  perform pg_temp.afirma(isg < commit_p and fsg >= commit_p,
    format('contencao: SOBREPOSICAO comprovada (segundo iniciou %s, primeiro commitou %s, segundo terminou %s)', isg, commit_p, fsg));
  perform pg_temp.afirma(extract(epoch from (fsg - isg)) >= 1.5,
    format('contencao: o segundo ficou esperando o lock (%s s)', round(extract(epoch from (fsg - isg))::numeric, 2)));
end $$;
select 'CONT CHECK OK' as resultado;
