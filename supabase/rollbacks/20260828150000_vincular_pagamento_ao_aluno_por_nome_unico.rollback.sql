update public.pagamentos p
   set aluno_id = b.aluno_id_antes, cpf = b.cpf_antes
  from public._backup_pagamento_vinculo_nome_20260828 b
 where p.id = b.pagamento_id;
