-- Vincula por NOME UNICO os pagamentos que ficaram sem dono.
--
-- Amanda, 31/08: "quero". O mutirao de 28/08 rodou so sobre agosto; julho ficou
-- de fora e concentrava o buraco -- 2.800 dos 5.042 pagamentos de julho
-- (R$ 4.810.365,11, 63% do mes) sem `aluno_id`. Sem dono nao ha saldo para
-- comparar, nao fecha parcela e nao aparece ao lado de baixa nenhuma: julho
-- estava fora da conferencia por falta de VINCULO, nao por falta de tela.
--
-- REGRA IDENTICA A DE AGOSTO, sem afrouxar: so vincula nome que aparece UMA
-- UNICA VEZ em toda a base. Nome repetido NUNCA entra -- e ali que o casamento
-- por nome erra, e a decisao segue humana. Normalizacao igual a de
-- `trg_pagamentos_gerar_confirmacao`: maiuscula, espaco colapsado, acento fora.
--
-- RESULTADO: 2.772 pagamentos vinculados, R$ 4.779.420,03. Julho caiu de 2.800
-- sem dono para 69; sobraram 112 no total (R$ 114.458,73) -- nome repetido ou
-- sem cadastro, que continuam sendo decisao humana.
--
-- SEGURO QUANTO A FILA: `pagamentos_gerar_confirmacao` e AFTER INSERT, entao um
-- UPDATE nao despeja nada na fila de confirmacao.
--
-- ISTO E MUTIRAO, NAO REGRA. Enquanto o gatilho de vinculo na entrada nao for
-- ligado (migration 20260828390000, ainda NAO aplicada), cada importacao nova
-- recria o problema -- foi assim que julho ficou para tras depois do mutirao de
-- agosto. Se junho for importado, ligar o gatilho ANTES.
--
-- Backup em `_backup_vinculo_nome_20260831`; desfazer e um UPDATE de volta.

create table if not exists public._backup_vinculo_nome_20260831 (
  pagamento_id uuid primary key,
  aluno_id_anterior uuid,
  aluno_id_novo uuid,
  aluno_nome text,
  valor_pago numeric,
  data_pagamento date,
  gravado_em timestamptz default now()
);
alter table public._backup_vinculo_nome_20260831 enable row level security;

with norm as (
  select a.id,
         translate(upper(regexp_replace(trim(coalesce(a.nome,'')), '\s+', ' ', 'g')),
                   'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nm
    from public.alunos a where coalesce(trim(a.nome),'') <> ''
),
unicos as (select nm, min(id::text)::uuid aluno_id from norm group by nm having count(*) = 1),
alvo as (
  select p.id pagamento_id, u.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
    from public.pagamentos p
    join unicos u
      on u.nm = translate(upper(regexp_replace(trim(coalesce(p.aluno_nome,'')), '\s+', ' ', 'g')),
                          'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
   where p.aluno_id is null and coalesce(trim(p.aluno_nome),'') <> ''
)
insert into public._backup_vinculo_nome_20260831
  (pagamento_id, aluno_id_anterior, aluno_id_novo, aluno_nome, valor_pago, data_pagamento)
select pagamento_id, null, aluno_id, aluno_nome, valor_pago, data_pagamento from alvo
on conflict (pagamento_id) do nothing;

update public.pagamentos p
   set aluno_id = b.aluno_id_novo
  from public._backup_vinculo_nome_20260831 b
 where p.id = b.pagamento_id and p.aluno_id is null;
