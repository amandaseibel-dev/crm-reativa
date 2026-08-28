-- Pagamento importado nao tinha vinculo nenhum com aluno: nem cpf, nem aluno_id,
-- nem matricula (o parser descartava a matricula -- corrigido no PR #238, mas
-- vale so para importacoes novas).
--
-- Vinculo por nome, com UMA trava: so quando o nome aparece UMA UNICA VEZ em
-- toda a base de alunos. Nome repetido nao entra -- e exatamente onde o
-- casamento por nome erra, e a base tem 109 nomes repetidos com CPFs
-- diferentes. Esses vao para a fila de validacao manual.
--
-- Medido em 2026-08-28: 3.229 de 3.275 pagamentos de agosto vincularam (98,6%).
-- Sobraram 46 (R$ 55.819,27): 29 de nome repetido e 17 sem cadastro na base.
--
-- Seguro de rodar: o gatilho que gera confirmacao de pagamento e AFTER INSERT,
-- entao este UPDATE nao despeja nada na fila de confirmacao.

create table if not exists public._backup_pagamento_vinculo_nome_20260828 as
select p.id as pagamento_id, p.aluno_id as aluno_id_antes, p.cpf as cpf_antes,
       p.aluno_nome, p.data_pagamento, p.valor_pago, now() as vinculado_em
from public.pagamentos p
where p.data_pagamento >= '2026-08-01' and p.aluno_id is null;

with nome_unico as (
  select upper(trim(a.nome)) as nome,
         (array_agg(a.id))[1] as aluno_id,
         (array_agg(a.cpf))[1] as cpf
    from public.alunos a
   group by 1 having count(*) = 1
)
update public.pagamentos p
   set aluno_id = n.aluno_id,
       cpf = coalesce(p.cpf, n.cpf)
  from nome_unico n
 where p.data_pagamento >= '2026-08-01'
   and p.aluno_id is null
   and upper(trim(coalesce(p.aluno_nome,''))) = n.nome;
