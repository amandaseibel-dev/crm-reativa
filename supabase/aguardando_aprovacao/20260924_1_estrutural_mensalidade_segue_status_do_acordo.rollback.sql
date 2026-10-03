-- ============================================================================
-- ROLLBACK do arquivo 1 (estrutural) -- volta as 3 funcoes a definicao EXATA
-- que estava em producao em 24/09/2026, antes da alteracao.
-- ============================================================================
-- Os corpos abaixo foram copiados de `pg_get_functiondef()` em producao em
-- 24/09/2026, nao reescritos de memoria.
--
-- AS COLUNAS NAO SAO DERRUBADAS AQUI, DE PROPOSITO. Se o arquivo 3 ja tiver
-- rodado, `quitacao_origem` e a unica prova gravada de por que cada mensalidade
-- esta paga -- derrubar a coluna apaga essa prova e nao tem volta. O bloco de
-- DROP fica no fim, comentado, para uso so se NADA tiver sido gravado.
-- ============================================================================

begin;

create or replace function public._titulo_quita_com_o_acordo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if upper(coalesce(new.status,'')) <> 'QUITADO'
     or upper(coalesce(old.status,'')) = 'QUITADO' then
    return new;
  end if;

  -- acordo marcado quitado mas com parcela viva nao quita mensalidade nenhuma
  if exists (select 1 from public.parcelas p
              where p.acordo_id = new.id
                and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')) then
    return new;
  end if;

  update public.acordos_titulos t
     set situacao = 'PAGO', status = 'quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'quitada junto com o acordo ' || coalesce(new.numero_acordo::text,'')
           || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
         atualizado_em = now()
   where t.acordo_id = new.id
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');

  return new;
end;
$function$;

create or replace function public.titulos_por_status_acordo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'QUITADO' then
    update public.acordos_titulos t set situacao = 'PAGO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('ABERTO','NEGOCIADO');

  elsif new.status = 'CANCELADO' then
    -- A MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA AQUI (branch removida em
    -- 22/09/2026): cancelar o acordo muda o estado do ACORDO, nao desfaz
    -- retroativamente a negociacao das mensalidades originais. Quem decide o
    -- destino do titulo e titulo_reavaliar, chamado pelo outro gatilho desta
    -- mesma tabela (trg_acordo_status_reavalia_titulos) -- ele preserva
    -- NEGOCIADO quando o motivo e so o acordo ter caido.

    -- o BOLETO DO PROPRIO ACORDO morre junto com ele, tendo mensalidade
    -- vinculada ou nao. Ele nunca foi divida: e o numero do documento.
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'boleto do proprio acordo, cancelado junto com o acordo em '
             || to_char(now(),'DD/MM/YYYY'),
           atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('NEGOCIADO','ABERTO')
       and coalesce(t.tipo_boleto,'') = 'Acordo';
  end if;

  return new;
end;
$function$;

create or replace function public.titulo_reavaliar(p_titulo uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/QUEBRADO/INATIVO): o
  -- cancelamento e uma mudanca de estado do ACORDO, nao uma decisao sobre a
  -- mensalidade original. A negociacao fica preservada no historico -- a
  -- reavaliacao automatica nao desfaz retroativamente o que foi negociado, nem
  -- soma de novo o valor como mensalidade em aberto. So entra aqui quando a
  -- situacao ATUAL do titulo ja e NEGOCIADO: se nunca foi negociado, ou se o
  -- motivo de nao achar vinculo vivo e outro, o caminho de baixo decide, como
  -- sempre decidiu.
  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO') then
      return;
    end if;
  end if;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

commit;

-- ---------------------------------------------------------------------------
-- BLOCO OPCIONAL -- so executar se NENHUMA linha tiver proveniencia gravada.
-- Confira antes:
--   select count(*) from public.acordos_titulos where quitacao_origem is not null;
-- Se der > 0, NAO execute: voce apagaria a prova de por que essas mensalidades
-- estao pagas.
-- ---------------------------------------------------------------------------
-- begin;
-- drop index if exists public.idx_acordos_titulos_quitacao_origem;
-- alter table public.acordos_titulos
--   drop constraint if exists acordos_titulos_quitacao_origem_check;
-- alter table public.acordos_titulos
--   drop column if exists quitacao_origem,
--   drop column if exists quitacao_origem_acordo_id,
--   drop column if exists quitacao_origem_em;
-- commit;
