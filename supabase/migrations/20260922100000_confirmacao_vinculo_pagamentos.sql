-- CONFIRMACAO x PAGAMENTOS: VINCULO GRAVADO NA ORIGEM (Bloco 1a)
--
-- Base: trg_pagamentos_gerar_confirmacao de producao lida em 21/09/2026 (pg_get_functiondef md5 9ba8d57594960ff839d22f92f3240066;
-- md5(prosrc)=9e6328d29e575b5641ffead39089c1cd). O texto abaixo e o de producao byte a byte + UM bloco final (marcado V-VINCULO).
-- O rollback restaura exatamente aquele texto.
--
-- PROBLEMA: a confirmacao gerada pelo import agrega varios pagamentos do dia e nao guarda quais (pagamento_id/parcela_id NULL em todas):
-- nao ha como provar depois que "o pagamento desta confirmacao ja foi baixado".
-- CORRECAO: tabela solicitacao_confirmacao_pagamentos gravada pelo proprio trigger de origem, so para a confirmacao criada/atualizada
-- pelo import (motivo fixo). UNIQUE(pagamento_id): um pagamento nunca muda de confirmacao. Sem backfill (o legado e resolvido pela chave
-- da mesma transacao, com prova de fuso, no resolver da migration seguinte).
-- NAO ALTERA NENHUM DADO EXISTENTE.
begin;

create table if not exists public.solicitacao_confirmacao_pagamentos (
  confirmacao_id uuid not null references public.solicitacoes_confirmacao_pagamento(id) on delete cascade,
  pagamento_id   uuid not null references public.pagamentos(id) on delete cascade,
  criado_em      timestamptz not null default now(),
  origem         text not null default 'TRIGGER_IMPORT',
  constraint solicitacao_confirmacao_pagamentos_pk primary key (confirmacao_id, pagamento_id),
  constraint solicitacao_confirmacao_pagamentos_pagamento_uq unique (pagamento_id)
);
comment on table public.solicitacao_confirmacao_pagamentos is
  'Prova de origem: quais pagamentos geraram cada confirmacao (gravada pelo trigger de import). Sem escrita direta por usuario.';
alter table public.solicitacao_confirmacao_pagamentos enable row level security;
revoke all on table public.solicitacao_confirmacao_pagamentos from public, anon, authenticated;
grant select on table public.solicitacao_confirmacao_pagamentos to authenticated;
grant select, insert, update, delete on table public.solicitacao_confirmacao_pagamentos to service_role;
drop policy if exists scp_gestao_le on public.solicitacao_confirmacao_pagamentos;
create policy scp_gestao_le on public.solicitacao_confirmacao_pagamentos for select to authenticated using (public.usuario_e_gestao());

CREATE OR REPLACE FUNCTION public.trg_pagamentos_gerar_confirmacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  with al as (
    select id, translate(upper(regexp_replace(trim(coalesce(nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm
    from public.alunos where coalesce(trim(nome),'')<>''),
  al_uni as (select nome_norm, (max(id::text))::uuid aluno_id from al group by nome_norm having count(*)=1),
  pag as (
    select translate(upper(regexp_replace(trim(coalesce(aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm,
      max(aluno_nome) aluno_nome, round(sum(coalesce(valor_pago,0)),2) valor,
      max(operador_email) op_email, max(operador_nome) op_nome, data_pagamento dt
    from new_rows
    where coalesce(trim(aluno_nome),'')<>'' and data_pagamento is not null
    group by 1, data_pagamento),
  elegivel as (
    select u.aluno_id, p.aluno_nome, p.valor, p.op_email, p.op_nome, p.dt
    from pag p join al_uni u using(nome_norm)
    -- Janela de 90 dias, nao "mes corrente" (Amanda, 02/09). O corte de mes
    -- fazia o arquivo do dia 1o perder tudo que era do mes anterior.
    where p.dt >= current_date - 90
  ),
  -- Reimportação do mesmo dia: atualiza o valor da que já está aguardando,
  -- em vez de criar outra linha para o mesmo pagamento.
  atualizadas as (
    update public.solicitacoes_confirmacao_pagamento s
       set valor_informado = e.valor,
           aluno_nome      = coalesce(s.aluno_nome, e.aluno_nome),
           operador_email  = coalesce(s.operador_email, e.op_email),
           operador_nome   = coalesce(s.operador_nome, e.op_nome),
           atualizado_em   = now()
      from elegivel e
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
    returning s.aluno_id, s.data_pagamento
  )
  insert into public.solicitacoes_confirmacao_pagamento
    (aluno_id, aluno_nome, valor_informado, operador_email, operador_nome, data_pagamento, tipo_pagamento, status, motivo)
  select e.aluno_id::text, e.aluno_nome, e.valor, e.op_email, e.op_nome, e.dt, null,
         'AGUARDANDO_CONFIRMACAO', 'Gerado do import de pagamentos Santander'
  from elegivel e
  where not exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
  );

  -- V-VINCULO: grava o vinculo SO para a confirmacao gerada pelo import (motivo fixo); UNIQUE(pagamento_id) impede mover pagamento entre confirmacoes.
  insert into public.solicitacao_confirmacao_pagamentos (confirmacao_id, pagamento_id)
  select s.id, n.id
    from new_rows n
    join public.alunos a on translate(upper(regexp_replace(trim(coalesce(a.nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') = translate(upper(regexp_replace(trim(coalesce(n.aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') and coalesce(trim(a.nome),'') <> ''
    join public.solicitacoes_confirmacao_pagamento s
      on s.aluno_id = a.id::text and s.data_pagamento = n.data_pagamento and s.status = 'AGUARDANDO_CONFIRMACAO' and s.motivo = 'Gerado do import de pagamentos Santander'
   where coalesce(trim(n.aluno_nome),'') <> '' and n.data_pagamento is not null
     and (select count(*) from public.alunos a2 where translate(upper(regexp_replace(trim(coalesce(a2.nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') = translate(upper(regexp_replace(trim(coalesce(n.aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')) = 1
  on conflict do nothing;

  return null;
end;
$function$;

commit;
