update public.pagamentos p set aluno_id = b.aluno_id_anterior
  from public._backup_vinculo_nome_20260831 b where p.id = b.pagamento_id;
