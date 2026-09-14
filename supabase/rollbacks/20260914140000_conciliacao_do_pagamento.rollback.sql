-- ROLLBACK de 20260914140000_conciliacao_do_pagamento.sql
--
-- Volta os DOIS gatilhos AFTER INSERT e devolve a fila ao eixo antigo
-- (`aluno_id IS NULL`). As duas funcoes antigas nao foram apagadas pela
-- migration justamente para isto: `_pagamento_baixa_pelo_documento` e
-- `_pagamento_enfileira_sem_vinculo` continuam no banco, intactas.
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO:
--   * nao apaga as colunas status_conciliacao / conciliacao_motivo /
--     conciliacao_em de `pagamentos`, nem status_conciliacao da fila. Coluna
--     com dado gravado nao se derruba para desfazer regra: o registro do que
--     aconteceu com cada pagamento continua valendo mesmo que a regra saia.
--   * nao desfaz baixa nenhuma. A escada da baixa e a mesma nas duas versoes,
--     entao nada que baixou baixou por causa desta migration.
--   * nao remove linhas da fila. Quem entrou por "nao baixou" continua la, com
--     o motivo; a fila apenas para de receber linhas novas com aluno.
--
-- Depois deste rollback a tela volta a mostrar so o que nao tem aluno -- e as
-- 11 linhas / R$ 4.655,12 que medimos em 14/09 voltam a ser invisiveis.

drop trigger if exists trg_pagamento_conciliar on public.pagamentos;

create trigger trg_pagamento_baixa_documento
  after insert on public.pagamentos
  for each row execute function public._pagamento_baixa_pelo_documento();

create trigger trg_pagamento_enfileira_sem_vinculo
  after insert on public.pagamentos
  for each row execute function public._pagamento_enfileira_sem_vinculo();

-- A RPC volta ao WHERE antigo. O resto da assinatura fica: tirar as duas
-- colunas novas obrigaria a tela a ser revertida no mesmo instante, e a tela
-- tolera colunas a mais (le por nome).
create or replace function public.pagamentos_sem_aluno(
  p_mes text default null,
  p_todos_os_meses boolean default false
)
returns table (
  pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
  titulo_numero text, numero_parcela_completo text, valor_pago numeric,
  valor_honorario numeric, operador_nome text, operador_email text,
  motivo text, candidatos integer, motivo_financeiro text, sugestoes jsonb,
  detectado_em timestamptz, importacao_id uuid, arquivo_nome text,
  status_conciliacao text, tem_aluno boolean
)
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    coalesce(f.motivo, 'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em, p.importacao_id, i.arquivo_nome,
    p.status_conciliacao, (p.aluno_id is not null)
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  where p.aluno_id is null
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$fn$;

grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated;
revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;
