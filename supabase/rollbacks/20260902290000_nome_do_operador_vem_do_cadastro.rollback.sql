-- Devolve os nomes como estavam e solta a trava.
-- Atenção: volta a haver 52 grafias para 10 operadores.
drop trigger if exists trg_pagamento_nome_do_operador on public.pagamentos;
drop function if exists public.tg_pagamento_nome_do_operador();

update pagamentos p set operador_nome = b.nome_antigo
  from _backup_operador_nome_20260902 b
 where b.pagamento_id = p.id;
