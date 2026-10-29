-- G2 / etapa 2 de 4 -- OS DOIS GATILHOS PARAM DE DECIDIR
--
-- CAUSA RAIZ DO G2, provada em 01/10/2026 em transacao abortada contra producao
-- (acordo 3712, 6 parcelas vivas: os 17 titulos NEGOCIADO viraram PAGO em 316 ms).
--
-- Tres gatilhos AFTER em `acordos` mexem em titulo quando o acordo vira QUITADO,
-- e gatilhos AFTER disparam em ORDEM ALFABETICA:
--
--   1. trg_acordo_status_reavalia_titulos -> titulo_reavaliar     GUARDA: sim
--   2. trg_titulo_quita_com_o_acordo      -> _titulo_quita_com... GUARDA: sim
--   3. trg_titulos_por_status_acordo      -> titulos_por_status...GUARDA: NAO
--
-- O ULTIMO a escrever era o unico sem guarda de parcela viva, e sobrescrevia a
-- decisao correta dos dois primeiros. Seu ramo QUITADO tinha quatro defeitos:
--   a) nenhuma guarda de parcela viva (os irmaos tem);
--   b) nao excluia tipo_boleto='Acordo' (o irmao exclui) -- origem do grupo C;
--   c) escrevia so `situacao`, deixando o par para o gatilho de coerencia;
--   d) nenhum motivo_ajuste e nenhuma proveniencia.
--
-- Variavel independente da ordem dos gatilhos: 144 dos 145 acordos do lote G2 ja
-- tinham parcela viva NASCIDA ANTES do evento QUITADO (614 de 615). A quitacao ja
-- era errada no instante em que aconteceu.
--
-- Esta versao faz os dois gatilhos DELEGAREM ao motor. As guardas do motor sao
-- TRES: vinculo vivo para acordo nao cancelado, acordo QUITADO, e ZERO parcela
-- viva (excluindo PAGO/CANCELADA/RENEGOCIADA). Nao remove gatilho nem muda o ramo
-- CANCELADO, preservado verbatim.
--
-- O QUE ESTA VERSAO NAO RESOLVE (medido em 01/10/2026): o motor NAO tem guarda de
-- `tipo_boleto`. A exclusao de tipo_boleto='Acordo' existia so em
-- _titulo_quita_com_o_acordo e nunca valeu na pratica, porque o TERCEIRO gatilho
-- (trg_acordo_status_reavalia_titulos) chama o motor direto e quita o boleto do
-- proprio acordo de qualquer forma. Logo esta delegacao NAO e regressao -- o
-- comportamento desse grupo fica identico ao de hoje -- mas o grupo C do G2 (18
-- titulos 'Acordo' PAGO com acordo ATIVO) segue fora do pacote e seguira sendo
-- produzido. Dar essa guarda ao motor muda a semantica do motor para TODOS os
-- chamadores: e frente separada.
--
-- POR QUE OS DOIS, e nao um so: eles casam o titulo por elos DIFERENTES --
-- _titulo_quita_com_o_acordo por `acordos_titulos.acordo_id`, titulos_por_status_
-- acordo pelo vinculo ativo -- e os dois elos divergem em 16 titulos do universo
-- G2 (4 so na coluna, 12 so no vinculo). Apagar um perde cobertura real. Chamar o
-- motor duas vezes para o mesmo titulo e inofensivo: o update dele tem guarda de
-- estado (`and (situacao<>... or status<>...)`), entao a segunda passada faz 0
-- linhas e nenhum gatilho.

-- ---------------------------------------------------------------------------
-- 1) titulos_por_status_acordo -- ramo QUITADO delega; ramo CANCELADO intacto
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'QUITADO' then
    -- NAO DECIDE MAIS NADA AQUI (01/10/2026). Ver o cabecalho desta versao: o
    -- update em bloco que existia aqui quitava mensalidade sem conferir parcela
    -- viva e foi a causa dos 491 titulos PAGO com acordo ATIVO (G2). Quem decide
    -- e titulo_reavaliar, que confere vinculo vivo, acordo QUITADO e ZERO parcela
    -- viva (RENEGOCIADA nao conta como viva), grava o PAR de colunas e a
    -- proveniencia ACORDO_QUITADO. Ele NAO confere tipo_boleto -- ver o cabecalho.
    perform public.titulo_reavaliar(v.titulo_id)
      from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id and coalesce(v.ativo, true);

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

comment on function public.titulos_por_status_acordo() is
  'Gatilho AFTER em acordos. QUITADO: delega a titulo_reavaliar por titulo do vinculo ativo (01/10/2026 -- antes quitava em bloco sem conferir parcela viva, causa do G2). CANCELADO: cancela so o boleto do proprio acordo (regra de 22/09/2026).';

-- ---------------------------------------------------------------------------
-- 2) _titulo_quita_com_o_acordo -- delega pelo elo da COLUNA acordo_id
-- ---------------------------------------------------------------------------
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

  -- Delega ao motor (01/10/2026). A guarda que existia aqui conferia parcela viva
  -- excluindo so ('PAGO','CANCELADA') -- deixava RENEGOCIADA contar como parcela
  -- viva, mais restritiva que o motor -- e nao gravava proveniencia nem o par de
  -- colunas. Perde-se o filtro de tipo_boleto='Acordo' que existia aqui, e isso
  -- NAO muda nada na pratica: o terceiro gatilho ja chamava o motor, que nao tem
  -- essa guarda. Elo pela COLUNA; o vinculo e coberto pelo outro gatilho.
  perform public.titulo_reavaliar(t.id)
    from public.acordos_titulos t
   where t.acordo_id = new.id;

  return new;
end;
$function$;

comment on function public._titulo_quita_com_o_acordo() is
  'Gatilho AFTER em acordos. Na virada para QUITADO delega a titulo_reavaliar por titulo ligado pela coluna acordo_id (01/10/2026 -- antes tinha update proprio com guarda parcial).';
