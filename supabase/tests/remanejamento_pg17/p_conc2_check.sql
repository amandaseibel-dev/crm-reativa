-- CONCORRENCIA B4, veredito. Independe de qual sessao termina primeiro:
--  (1) as duas sessoes registraram resultado sem erro;
--  (2) cada sessao moveu exatamente a sua vaga (1), somando 2;
--  (3) cada aluno tem o responsavel esperado: o grupo A so pode estar com a Luana ou com a carteira;
--      o grupo B so pode estar com a Mauricio ou com a carteira; nenhum cruza destino;
--  (4) contadores: exatamente 1 aluno de cada grupo foi movido, e a ocupacao final de cada destino
--      e 3 (2 iniciais + 1), igual ao teto; nenhum destino ultrapassou o teto.
\i lib.sql
do $$
declare ra jsonb; rb jsonb; teto int := 3; v_luana int; v_mau int; n_ab int; n_ba int;
  n_a_luana int; n_b_mau int; n_a_carteira int; n_b_carteira int;
  e_a1 text; e_a2 text; e_b1 text; e_b2 text;
begin
  select resultado into ra from public.cg_teste2_res where sessao = 'a';
  select resultado into rb from public.cg_teste2_res where sessao = 'b';

  -- (1)
  perform pg_temp.afirma(ra is not null and rb is not null, 'B4: as duas sessoes registraram resultado');
  perform pg_temp.afirma(not (ra ? 'erro') and not (rb ? 'erro'),
    format('B4: nenhuma sessao terminou com erro (a=%s b=%s)', coalesce(ra::text,'-'), coalesce(rb::text,'-')));

  -- (2)
  perform pg_temp.afirma((ra->>'alunos_movidos')::int = 1 and (rb->>'alunos_movidos')::int = 1,
    format('B4: cada sessao moveu a sua vaga (a=%s, b=%s)', ra->>'alunos_movidos', rb->>'alunos_movidos'));

  -- (3) responsavel de cada aluno (dono do caso e responsavel do aluno devem concordar)
  select operador_email into e_a1 from public.casos where id = (select caso from public.cg_teste2_ids where nome = 'A1');
  select operador_email into e_a2 from public.casos where id = (select caso from public.cg_teste2_ids where nome = 'A2');
  select operador_email into e_b1 from public.casos where id = (select caso from public.cg_teste2_ids where nome = 'B1');
  select operador_email into e_b2 from public.casos where id = (select caso from public.cg_teste2_ids where nome = 'B2');

  n_a_luana := (e_a1 = 'cobranca05@aelbra.com.br')::int + (e_a2 = 'cobranca05@aelbra.com.br')::int;
  n_a_carteira := (e_a1 = 'carteira.geral@reativa.local')::int + (e_a2 = 'carteira.geral@reativa.local')::int;
  n_b_mau := (e_b1 = 'cobranca06@aelbra.com.br')::int + (e_b2 = 'cobranca06@aelbra.com.br')::int;
  n_b_carteira := (e_b1 = 'carteira.geral@reativa.local')::int + (e_b2 = 'carteira.geral@reativa.local')::int;

  perform pg_temp.afirma(n_a_luana + n_a_carteira = 2 and n_b_mau + n_b_carteira = 2,
    format('B4: cada aluno esta com o destino de seu grupo ou na carteira (A: %s/%s; B: %s/%s)', e_a1, e_a2, e_b1, e_b2));
  perform pg_temp.afirma(n_a_luana = 1 and n_a_carteira = 1,
    format('B4: exatamente 1 aluno do grupo A foi para a Luana (grupo A: %s, %s)', e_a1, e_a2));
  perform pg_temp.afirma(n_b_mau = 1 and n_b_carteira = 1,
    format('B4: exatamente 1 aluno do grupo B foi para a Mauricio (grupo B: %s, %s)', e_b1, e_b2));

  -- responsavel do ALUNO tem de bater com o dono do caso (sem divergencia entre as duas tabelas)
  perform pg_temp.afirma(
    (select responsavel_atual_email from public.alunos where id = (select aluno from public.cg_teste2_ids where nome = 'A1')) = e_a1
    and (select responsavel_atual_email from public.alunos where id = (select aluno from public.cg_teste2_ids where nome = 'A2')) = e_a2
    and (select responsavel_atual_email from public.alunos where id = (select aluno from public.cg_teste2_ids where nome = 'B1')) = e_b1
    and (select responsavel_atual_email from public.alunos where id = (select aluno from public.cg_teste2_ids where nome = 'B2')) = e_b2,
    'B4: responsavel do aluno bate com o dono do caso, em todos os quatro');

  -- (4) contadores e teto por destino
  select count(*) into v_luana from public.casos where operador_email = 'cobranca05@aelbra.com.br' and not coalesce(encerrado_operacional, false);
  select count(*) into v_mau from public.casos where operador_email = 'cobranca06@aelbra.com.br' and not coalesce(encerrado_operacional, false);
  perform pg_temp.afirma(v_luana = 3 and v_mau = 3,
    format('B4: ocupacao final = 3 em cada destino (Luana=%s, Mauricio=%s)', v_luana, v_mau));
  perform pg_temp.afirma(v_luana <= teto and v_mau <= teto,
    format('B4: nenhum destino ultrapassou o teto de %s (Luana=%s, Mauricio=%s)', teto, v_luana, v_mau));
  raise notice 'B4 resultado: a=% b=% | A: %/% | B: %/% | ocupacao Luana=% Mauricio=%',
    ra->>'alunos_movidos', rb->>'alunos_movidos', e_a1, e_a2, e_b1, e_b2, v_luana, v_mau;
end $$;
select 'CONC2 CHECK OK' as resultado;
