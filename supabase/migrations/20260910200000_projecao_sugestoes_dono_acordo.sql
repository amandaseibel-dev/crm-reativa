-- SUGESTAO: pagamento creditado a quem nao e o dono do acordo.
--
-- Pedido da gestao em 10/09/2026: "se o operador cobrar e tiver realmente de
-- fato cobrado deve ficar com o pagamento -- para isso precisamos atrelar o
-- usuario que vem na projecao ao dono do acordo". A Fernanda fecha acordos fora
-- do turno para o operador, e o credito acaba indo para quem registrou.
--
-- SUGERE, nao aplica. A gestao confirma caso a caso pela Projecao, e a troca em
-- si continua sendo `projecao_alterar_operador`, que ja audita e ja atualiza o
-- snapshot do mes. Automatizar seria mexer em comissao sem ninguem olhar.
--
-- So entra pagamento de aluno com UM acordo ativo: com dois ou mais nao ha como
-- saber a qual deles o pagamento pertence, e um palpite aqui vira dinheiro na
-- mao da pessoa errada.
--
-- `entre_operadores` separa o caso que a gestao descreveu (um operador ativo
-- deveria ter recebido) do credito que veio com nome de fora no arquivo do
-- Santander (STEPHANIE.PAULA, ADEMIR.SANTOS...) -- em setembro/2026 eram 6 e
-- 23, e sao decisoes de natureza diferente.
create or replace function public.projecao_sugestoes_dono_acordo(p_mes text default null)
returns table (
  pagamento_id uuid, data_pagamento date, aluno_id uuid, aluno_nome text,
  valor_pago numeric, valor_honorario numeric,
  creditado_email text, creditado_nome text,
  dono_acordo_email text, dono_acordo_nome text,
  acordo_id uuid, acordo_status text, acordo_criado_em timestamptz,
  entre_operadores boolean, ja_ajustado boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with mes as (
    select coalesce(p_mes, to_char(current_date,'YYYY-MM')) m
  ),
  base as (
    select p.id, p.data_pagamento, p.aluno_id, p.aluno_nome, p.valor_pago, p.valor_honorario,
           p.operador_email, p.operador_nome, coalesce(p.operador_ajustado_manualmente,false) ajustado,
           (select count(*) from public.acordos a where a.aluno_id = p.aluno_id and a.status = 'ATIVO') n_acordos,
           (select a.id from public.acordos a where a.aluno_id = p.aluno_id and a.status = 'ATIVO'
             order by a.criado_em desc limit 1) acordo_id
      from public.pagamentos p, mes
     where to_char(p.data_pagamento,'YYYY-MM') = mes.m
       and p.aluno_id is not null
  )
  select b.id, b.data_pagamento, b.aluno_id, b.aluno_nome, b.valor_pago, b.valor_honorario,
         b.operador_email, b.operador_nome,
         a.operador_responsavel_email, u.nome,
         a.id, a.status, a.criado_em,
         (u.email is not null and u.ativo and u.perfil = 'operador'
          and exists (select 1 from public.usuarios o
                       where lower(o.email) = lower(coalesce(b.operador_email,''))
                         and o.ativo and o.perfil = 'operador')),
         b.ajustado
    from base b
    join public.acordos a on a.id = b.acordo_id
    left join public.usuarios u on u.email = a.operador_responsavel_email
   where b.n_acordos = 1
     and a.operador_responsavel_email is not null
     and lower(coalesce(b.operador_email,'')) <> lower(a.operador_responsavel_email)
   order by b.valor_pago desc;
$$;

revoke all on function public.projecao_sugestoes_dono_acordo(text) from public, anon;
grant execute on function public.projecao_sugestoes_dono_acordo(text) to authenticated;

comment on function public.projecao_sugestoes_dono_acordo(text) is
  'Sugere pagamentos cujo credito nao e o dono do acordo (so aluno com acordo unico). Alimenta a aba de sugestoes da Projecao; aplicar continua sendo projecao_alterar_operador.';
