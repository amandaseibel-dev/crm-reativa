-- Desfaz 20260902100000: devolve os 16 vazios (e os 2 gemeos) ao estado do backup.
update public.alunos a
   set status_atual = b.status_atual,
       status_jornada = b.status_jornada,
       saldo_total = b.saldo_total,
       observacao = b.observacao
  from public._backup_cadastros_vazios_20260902 b
 where a.id = b.id;
