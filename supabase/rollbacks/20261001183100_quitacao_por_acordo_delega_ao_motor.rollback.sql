-- ============================================================================
-- ROLLBACK de 20261001183100 -- os dois gatilhos voltam a decidir sozinhos.
-- ============================================================================
-- ATENCAO: isto RESTAURA A CAUSA RAIZ DO G2. titulos_por_status_acordo volta a
-- quitar mensalidade em bloco SEM conferir parcela viva. Use somente se a
-- delegacao ao motor quebrar algo pior.
--
-- Copia literal de pg_get_functiondef de producao em 01/10/2026:
--   titulos_por_status_acordo   md5=67e21573381adb98f82fd9c8ff969bfc bytes=1538
--   _titulo_quita_com_o_acordo  md5=bde4388c3a26ea98f66e5163eef9bd51 bytes=994
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public._titulo_quita_com_o_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

commit;
