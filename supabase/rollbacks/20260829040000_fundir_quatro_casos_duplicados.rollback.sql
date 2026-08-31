-- Reabre as copias e devolve o caso que ficou ao estado anterior.
update public.casos c set encerrado_operacional = false
  from public._backup_fusao_casos_20260829 b where c.id = b.caso_encerra;
update public.casos c
   set operador_email = b.fica_operador_antes,
       data_ultimo_acionamento = b.fica_acionamento_antes
  from public._backup_fusao_casos_20260829 b where c.id = b.caso_fica;
