-- Indicadores do piloto da Central WhatsApp.
-- Roda em produção, só leitura.
with entradas as (
  select m.* from public.whatsapp_mensagens m where m.direcao = 'ENTRADA'
),
primeira_resposta as (
  select e.conversa_id,
         min(e.timestamp_wa) as primeira_entrada,
         (select min(s.timestamp_wa) from public.whatsapp_mensagens s
           where s.conversa_id = e.conversa_id and s.direcao = 'SAIDA'
             and s.status is distinct from 'FALHOU'
             and s.timestamp_wa > min(e.timestamp_wa)) as resposta
  from entradas e group by e.conversa_id
)
select
  (select count(*) from entradas)                                          as entradas_no_banco,
  (select count(*) from public.whatsapp_conversas)                         as conversas,
  (select count(*) from public.whatsapp_conversas where aguardando_resposta) as sem_retorno,
  (select count(*) from public.whatsapp_conversas where nao_lidas > 0)     as conversas_com_badge,
  (select coalesce(sum(nao_lidas),0) from public.whatsapp_conversas)       as total_nao_lidas,
  (select count(*) from public.whatsapp_conversas where responsavel_email is null
                                                   and status <> 'ENCERRADO') as sem_responsavel,
  (select round(avg(extract(epoch from (resposta - primeira_entrada)))/60.0, 1)
     from primeira_resposta where resposta is not null)                    as minutos_ate_1a_resposta,
  (select count(*) from primeira_resposta where resposta is null)          as entradas_sem_resposta,
  (select count(*) from public.whatsapp_conexao_eventos
     where criado_em > now() - interval '24 hours'
       and evento in ('DESCONECTADO','ERRO','PAREAMENTO_NECESSARIO'))      as quedas_24h,
  (select count(*) from public.whatsapp_conexao_eventos
     where criado_em > now() - interval '24 hours' and evento = 'CONECTADO') as reconexoes_24h,
  (select count(*) from public.notificacoes
     where tipo like 'WHATSAPP_%' and criado_em > now() - interval '24 hours') as alertas_24h,
  (select round(extract(epoch from (now()-ultimo_heartbeat_em)))::int
     from public.whatsapp_canais where sessao_chave='piloto')              as heartbeat_ha_seg,
  (select conexao_status from public.whatsapp_canais where sessao_chave='piloto') as status;
