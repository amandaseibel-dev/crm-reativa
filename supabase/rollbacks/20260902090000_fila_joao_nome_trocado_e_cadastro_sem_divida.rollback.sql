-- Desfaz 20260902090000: devolve os dois registros ao estado gravado no backup.
update public.alunos a
   set nome_aluno = b.nome_aluno,
       status_atual = b.status_atual,
       status_jornada = b.status_jornada,
       situacao_operacional = b.situacao_operacional,
       saldo_total = b.saldo_total,
       observacao = b.observacao
  from public._backup_fila_joao_20260902 b
 where a.id = b.id;

-- A tabela de backup fica: e o registro de como estava.
