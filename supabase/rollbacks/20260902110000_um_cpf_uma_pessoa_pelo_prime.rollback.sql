-- Desfaz 20260902110000: devolve titulos, acordos, casos e os dois cadastros.
do $$
declare b record;
begin
  for b in select * from public._fusao_cpf_prime_20260902 loop
    update public.acordos_titulos set aluno_id = b.sai where id = any(b.titulos_movidos);
    update public.acordos set aluno_id = b.sai where id = any(b.acordos_movidos);
    update public.casos set encerrado_operacional = false where id = any(b.casos_encerrados);

    update public.alunos
       set nome = b.nome_antigo_fica, nome_aluno = b.nome_aluno_antigo_fica, cpf = b.cpf_antigo_fica
     where id = b.fica;

    update public.alunos
       set status_atual = b.status_antigo_sai, status_jornada = b.status_jornada_antigo_sai,
           saldo_total = b.saldo_antigo_sai, observacao = b.observacao_antiga_sai
     where id = b.sai;

    perform public.recalcular_situacao_aluno(b.fica, 'rollback_fusao_cpf_prime');
    perform public.recalcular_situacao_aluno(b.sai, 'rollback_fusao_cpf_prime');
  end loop;
end $$;
