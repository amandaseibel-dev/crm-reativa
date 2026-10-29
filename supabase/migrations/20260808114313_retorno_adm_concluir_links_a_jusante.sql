-- Retornos do ADM ("Link pronto p/ envio") ficavam presos como PENDENTE no topo
-- da carteira do operador mesmo depois do link ja ter sido enviado / baixado.
--
-- Causa: tg_links_concluir_retorno_adm so concluia o retorno na transicao EXATA
-- para 'LINK_ENVIADO_AO_ALUNO'. Muitos links pulam esse estado (vao de
-- LINK_PRONTO_PARA_ENVIO direto para AGUARDANDO_BAIXA / BAIXA_REALIZADA via
-- comprovante), entao o retorno nunca era concluido.
--
-- Correcao: concluir o retorno sempre que o link atinge QUALQUER estado a jusante
-- do envio (enviado, aguardando comprovante/baixa, baixado, devolvido) ou for
-- cancelado. Idempotente e resiliente (nao trava o update do link).

create or replace function public.tg_links_concluir_retorno_adm()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_afetados int;
  -- Estados em que o link ja saiu da mesa "pronto para envio": nesse ponto o
  -- retorno do ADM ("envie o link ao aluno") deixa de ser uma pendencia.
  v_a_jusante text[] := array[
    'LINK_ENVIADO_AO_ALUNO',
    'AGUARDANDO_COMPROVANTE',
    'AGUARDANDO_BAIXA',
    'BAIXA_REALIZADA',
    'BAIXA_DEVOLVIDA',
    'CANCELADO'
  ];
begin
  if new.status = any(v_a_jusante)
     and old.status is distinct from new.status then
    begin
      update public.retornos_adm
        set status_tratamento = 'CONCLUIDO', concluido_em = now(), concluido_por = auth.email()
        where origem = 'links_pagamento' and solicitacao_id = new.id::text
          and resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
          and status_tratamento in ('PENDENTE','EM_TRATAMENTO');
      get diagnostics v_afetados = row_count;
      if v_afetados > 0 then
        insert into public.aluno_movimentacoes(
          aluno_id, tipo, descricao, status_anterior, status_novo,
          registrado_por_nome, registrado_por_email, registrado_em
        ) values (
          new.aluno_id, 'RETORNO_ADM_CONCLUIDO',
          case when new.status = 'CANCELADO'
               then 'Retorno do ADM encerrado: link cancelado.'
               else 'Retorno do ADM concluído: link enviado ao aluno.' end,
          'LINK_PRONTO_PARA_ENVIO', new.status,
          'Sistema (Retorno ADM)', auth.email(), now()
        );
      end if;
    exception when others then
      raise notice 'tg_links_concluir_retorno_adm falhou (ignorado): %', sqlerrm;
    end;
  end if;
  return new;
end $function$;

-- Backfill: concluir os retornos que ja estao presos apesar do link ter avancado.
with alvo as (
  select r.id
  from public.retornos_adm r
  join public.links_pagamento lp on lp.id::text = r.solicitacao_id
  where r.origem = 'links_pagamento'
    and r.resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
    and r.status_tratamento in ('PENDENTE','EM_TRATAMENTO')
    and lp.status in (
      'LINK_ENVIADO_AO_ALUNO','AGUARDANDO_COMPROVANTE','AGUARDANDO_BAIXA',
      'BAIXA_REALIZADA','BAIXA_DEVOLVIDA','CANCELADO'
    )
)
update public.retornos_adm r
  set status_tratamento = 'CONCLUIDO',
      concluido_em = coalesce(r.concluido_em, now()),
      concluido_por = coalesce(r.concluido_por, 'sistema (backfill a jusante)')
  from alvo
  where r.id = alvo.id;
