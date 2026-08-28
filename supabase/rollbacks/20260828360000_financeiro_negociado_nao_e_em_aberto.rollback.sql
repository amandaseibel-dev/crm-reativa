-- Volta a contar como "em aberto" tudo que nao e PAGO (comportamento anterior).
create or replace view public.consulta_financeira_por_aluno as
select a.id as aluno_id, a.nome, a.cpf, a.responsavel_atual_email, a.responsavel_atual_nome,
  count(t.id) as qtd_titulos,
  count(t.id) filter (where t.situacao <> 'PAGO') as qtd_em_aberto,
  count(t.id) filter (where t.situacao = 'PAGO') as qtd_pagos,
  coalesce(sum(t.saldo_corrigido) filter (where t.situacao <> 'PAGO'), 0::numeric) as valor_em_aberto,
  min(t.vencimento) filter (where t.situacao <> 'PAGO') as proximo_vencimento,
  count(t.id) filter (where t.situacao <> 'PAGO' and t.vencimento < current_date) > 0 as tem_atraso,
  case when count(t.id) filter (where t.situacao <> 'PAGO') = 0 then 'PAGO'
       when count(t.id) filter (where t.situacao = 'PAGO') > 0 then 'PARCIAL'
       else 'EM_ABERTO' end as situacao_geral
from public.alunos a join public.acordos_titulos t on t.cpf = a.cpf
group by a.id, a.nome, a.cpf, a.responsavel_atual_email, a.responsavel_atual_nome;
