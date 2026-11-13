-- Dados SINTETICOS. Tres casos do mesmo dono (MAURICIO), 20 dias sem acionamento.
-- U1 = disputa entre dois operadores; U2 = acionamento so no aluno; U3 = acionamento so no caso.
\set ON_ERROR_STOP on
do $seed$
declare r record;
begin
  for r in select * from (values
      (1,'00000000-0000-0000-0000-000000000001'::uuid,'30000000001'),
      (2,'00000000-0000-0000-0000-000000000002'::uuid,'30000000002'),
      (3,'00000000-0000-0000-0000-000000000003'::uuid,'30000000003')) v(n,id,cpf) loop
    insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em)
      values (r.id, r.cpf, 'Aluno Sintetico '||r.n, 'M'||r.n, 'cobranca06@aelbra.com.br', 'MAURICIO', now() - interval '5 days');
    insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status)
      values (r.id, r.cpf, 'DOC'||r.n, '2026-03-10', 500, 500, 'ABERTO', 'em_aberto');
    insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, operador_nome, data_ultimo_acionamento,
        ultima_tabulacao_em, caso_codigo)
      values (r.id, r.cpf, r.cpf, 'Aluno Sintetico '||r.n, 'cobranca06@aelbra.com.br', 'MAURICIO',
        current_date - 20, '2026-08-01T10:00:00', r.n);
  end loop;
end
$seed$;
