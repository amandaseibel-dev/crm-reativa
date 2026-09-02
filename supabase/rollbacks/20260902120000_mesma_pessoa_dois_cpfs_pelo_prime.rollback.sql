-- Desfaz 20260902120000.
do $$
declare b record;
begin
  for b in select * from public._fusao_mesma_pessoa_20260902 loop
    update public.acordos_titulos set aluno_id = b.sai where id = any(b.titulos_movidos);
    update public.acordos set aluno_id = b.sai where id = any(b.acordos_movidos);
    update public.casos set encerrado_operacional = false where id = any(b.casos_encerrados);

    update public.alunos
       set responsavel_atual_email = b.fica_resp_email_antes,
           responsavel_atual_nome  = b.fica_resp_nome_antes,
           responsavel_atual_em    = b.fica_resp_em_antes,
           data_ultimo_acionamento = b.fica_acionamento_antes,
           status_atual = b.fica_status_antes,
           status_jornada = b.fica_jornada_antes,
           data_retorno = b.fica_retorno_antes,
           observacao = b.fica_observacao_antes
     where id = b.fica;

    update public.alunos
       set status_atual = b.sai_status_antes, status_jornada = b.sai_jornada_antes,
           saldo_total = b.sai_saldo_antes, observacao = b.sai_observacao_antes
     where id = b.sai;

    perform public.recalcular_situacao_aluno(b.fica, 'rollback_fusao_mesma_pessoa');
    perform public.recalcular_situacao_aluno(b.sai, 'rollback_fusao_mesma_pessoa');
  end loop;
end $$;
