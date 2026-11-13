-- Dados sintéticos. NENHUM dado real: CPF, nome e e-mail inventados.
-- Três alunos de giro vencido, parados há 15 dias, do mesmo operador.
set client_min_messages to warning;

insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
  ('OP UM',   'op1@teste.local', 'operador', true, 'OP UM',   true),
  ('OP DOIS', 'op2@teste.local', 'operador', true, 'OP DOIS', true),
  ('GESTORA', 'amanda.seibel@aelbra.com.br', 'gerencia', true, null, false)
on conflict do nothing;

insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '3000'::jsonb)
on conflict (chave) do update set valor = excluded.valor;

do $$
declare n int;
begin
  for n in 1..3 loop
    insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em)
    values (('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
            (70000000000 + n)::text, 'Aluno ' || n, 'M' || n, 'op1@teste.local', 'OP UM', now() - interval '30 days');

    insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status)
    values (('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
            (70000000000 + n)::text, 'DOC' || n, current_date - 90, 500, 500, 'ABERTO', 'em_aberto');

    insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, chave_unificacao, operador_email, operador_nome,
                              data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, total_em_aberto,
                              caso_codigo, caso_atualizado_em, nao_acionar)
    values (('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
            ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
            (70000000000 + n)::text, (70000000000 + n)::text, 'Aluno ' || n, (70000000000 + n)::text,
            'op1@teste.local', 'OP UM', current_date - 15, current_date - 17,
            now() - interval '20 days', 500, n, now() - interval '30 days', false);
  end loop;
end $$;
