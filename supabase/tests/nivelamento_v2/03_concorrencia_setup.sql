-- CONCORRENCIA: prepara uma unica baixa elegivel e um caso livre.
-- O CI dispara DUAS conexoes psql ao mesmo tempo chamando
-- nivelamento_reposicao_por_baixas. Esperado: exatamente UMA REPOSICAO_V2
-- para esta baixa (trava de advisory + indice unico por baixa).
\set ON_ERROR_STOP on

insert into public.casos(id, aluno_id, cpf_limpo, nome, status_atual) values
  ('60000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a00a','909','LC','Sem contato');

insert into public.baixas_pagamento(id, aluno_id, aluno_cpf, valor_pago, status_baixa, baixado_em)
values ('70000000-0000-0000-0000-000000000001','a','111', 999, 'REALIZADA', now());
update public.calibragem_parametros set valor = to_jsonb(700) where chave = 'limite_carteira';
