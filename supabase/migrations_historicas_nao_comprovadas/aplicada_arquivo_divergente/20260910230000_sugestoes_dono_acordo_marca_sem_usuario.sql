-- CORRECAO DO CRITERIO (mesmo dia, 10/09/2026).
--
-- Eu tinha separado a lista por "entre operadores da equipe", supondo que o
-- caso a corrigir fosse o credito de um operador para outro. A gestao corrigiu:
-- "o que e da operacao, na teoria, nao precisa mexer -- o que vamos precisar
-- ajustar sao de pessoas que nao tem usuario cadastrado".
--
-- Faz sentido: credito entre gente da casa e decisao de quem trabalhou o caso,
-- e a Projecao ja permite trocar. O que e claramente errado e o pagamento ficar
-- com um nome que nem existe no sistema -- STEPHANIE.PAULA, ADEMIR.SANTOS,
-- TYMOTHEO.FINANCEIRO... -- que vem como texto no arquivo do Santander e nao
-- correspondem a nenhum usuario. Esse credito nao e de ninguem.
--
-- `creditado_sem_usuario` substitui `entre_operadores` como marca principal.
-- Em setembro/2026: 18 pagamentos (R$ 7.134,38) creditados a quem nao tem
-- usuario, contra 21 entre gente cadastrada.
drop function if exists public.projecao_sugestoes_dono_acordo(text);
create or replace function public.projecao_sugestoes_dono_acordo(p_mes text default null)
returns table (
  pagamento_id uuid, data_pagamento date, aluno_id uuid, aluno_nome text,
  valor_pago numeric, valor_honorario numeric,
  creditado_email text, creditado_nome text,
  dono_acordo_email text, dono_acordo_nome text,
  acordo_id uuid, acordo_status text, acordo_criado_em timestamptz,
  creditado_sem_usuario boolean, entre_operadores boolean, ja_ajustado boolean
)
language sql stable security definer set search_path = public
as $$
  with mes as (select coalesce(p_mes, to_char(current_date,'YYYY-MM')) m),
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
         not exists (select 1 from public.usuarios o
                      where lower(o.email) = lower(coalesce(b.operador_email,''))),
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
  'Sugere pagamentos cujo credito nao e o dono do acordo (so aluno com acordo unico). creditado_sem_usuario marca o credito que ficou com nome sem usuario no sistema -- o caso que a gestao quer corrigir.';
