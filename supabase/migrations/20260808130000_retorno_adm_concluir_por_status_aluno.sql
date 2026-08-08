-- Complemento do fix anterior (20260808120000).
--
-- Descoberta: o retorno tambem fica preso quando o operador envia o link e o
-- ALUNO avanca (alunos.status_atual = fonte de verdade), mas a linha em
-- links_pagamento nao acompanha (fica congelada em LINK_PRONTO_PARA_ENVIO).
-- O gatilho anterior le o status do LINK, entao nao concluia esses casos.
--
-- Correcao: quando o aluno SAI de LINK_PRONTO_PARA_ENVIO (avancou / mudou de
-- trilha), o retorno "envie o link" deixa de ser a acao atual -> conclui os
-- retornos pendentes daquele aluno. WHEN barato (so dispara nessa saida).

create or replace function public.tg_aluno_concluir_retorno_adm_link()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare v_afetados int;
begin
  begin
    update public.retornos_adm
      set status_tratamento = 'CONCLUIDO', concluido_em = now(),
          concluido_por = coalesce(auth.email(), 'sistema (status do aluno avancou)')
      where aluno_id = new.id
        and origem = 'links_pagamento'
        and resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
        and status_tratamento in ('PENDENTE','EM_TRATAMENTO');
    get diagnostics v_afetados = row_count;
    if v_afetados > 0 then
      insert into public.aluno_movimentacoes(
        aluno_id, tipo, descricao, status_anterior, status_novo,
        registrado_por_nome, registrado_por_email, registrado_em
      ) values (
        new.id, 'RETORNO_ADM_CONCLUIDO',
        'Retorno do ADM concluído: aluno avançou de "link pronto para envio".',
        'LINK_PRONTO_PARA_ENVIO', new.status_atual,
        'Sistema (Retorno ADM)', auth.email(), now()
      );
    end if;
  exception when others then
    raise notice 'tg_aluno_concluir_retorno_adm_link falhou (ignorado): %', sqlerrm;
  end;
  return new;
end $function$;

drop trigger if exists trg_aluno_concluir_retorno_adm_link on public.alunos;
create trigger trg_aluno_concluir_retorno_adm_link
  after update of status_atual on public.alunos
  for each row
  when (old.status_atual = 'LINK_PRONTO_PARA_ENVIO'
        and new.status_atual is distinct from 'LINK_PRONTO_PARA_ENVIO')
  execute function public.tg_aluno_concluir_retorno_adm_link();

-- Backfill: concluir retornos pendentes cujo aluno ja saiu de LINK_PRONTO.
update public.retornos_adm r
  set status_tratamento = 'CONCLUIDO',
      concluido_em = coalesce(r.concluido_em, now()),
      concluido_por = coalesce(r.concluido_por, 'sistema (backfill status aluno)')
  from public.alunos a
  where a.id = r.aluno_id
    and r.origem = 'links_pagamento'
    and r.resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
    and r.status_tratamento in ('PENDENTE','EM_TRATAMENTO')
    and a.status_atual is distinct from 'LINK_PRONTO_PARA_ENVIO';
