-- ROLLBACK de 20261026103000_whatsapp_comercial_limites_abordagem.sql
--
-- Devolve o freio da fase e os limites do Comercial ao estado de 26/10/2026:
--   whatsapp_config.teto_abordagens_operador        8 -> 3
--   whatsapp_canais(comercial).limite_..._operador  8 -> 2
--   whatsapp_canais(comercial).limite_..._canal    30 -> NULL
--
-- O QUE SE PERDE AO REVERTER, dito sem rodeio: o teto de canal volta a NULL,
-- isto e, SEM LIMITE AGREGADO -- o numero fica outra vez sem barreira coletiva
-- de abordagem, que e a situacao em que o pico de 38/dia aconteceu. Reverter
-- devolve a restricao individual de 2/dia E reabre esse buraco. Nao e voltar a
-- um estado mais seguro: e voltar ao estado anterior, com as duas pontas.
--
-- NAO apaga `whatsapp_abordagens` nem `whatsapp_cadencia_bloqueios`: consumo e
-- bloqueio sao trilha, nao configuracao. Reverter o limite nao apaga a medicao
-- que justificaria subi-lo de novo.
--
-- A ORDEM E INVERSA A DA MIGRATION, de proposito: baixa primeiro o limite do
-- canal e so depois o teto. Baixar o teto antes deixaria, por um instante,
-- limite_abordagens_operador = 8 acima do teto = 3.
--
-- Idempotente e falha fechado, pelo mesmo desenho da migration.
do $$
declare
  v_teto      integer;
  v_op_atual  integer;
  v_ch_atual  integer;
  v_linhas    integer;
begin
  select teto_abordagens_operador into v_teto from public.whatsapp_config limit 1;
  select limite_abordagens_operador, limite_abordagens_canal
    into v_op_atual, v_ch_atual
    from public.whatsapp_canais
   where sessao_chave = 'comercial';

  if not found then
    raise exception 'canal comercial nao encontrado em whatsapp_canais'
      using errcode = '42704';
  end if;

  if v_teto = 3 and v_op_atual = 2 and v_ch_atual is null then
    raise notice 'ja esta em teto 3 e Comercial 2/NULL - nada a fazer';
    return;
  end if;

  if v_teto is distinct from 8
     or v_op_atual is distinct from 8
     or v_ch_atual is distinct from 30 then
    raise exception
      'estado inesperado: teto=% operador=% canal=% (esperado 8/8/30 ou 3/2/NULL)',
      coalesce(v_teto::text,'NULL'), coalesce(v_op_atual::text,'NULL'),
      coalesce(v_ch_atual::text,'NULL')
      using errcode = '22023';
  end if;

  update public.whatsapp_canais
     set limite_abordagens_operador = 2,
         limite_abordagens_canal    = null
   where sessao_chave = 'comercial';
  get diagnostics v_linhas = row_count;
  if v_linhas <> 1 then
    raise exception 'esperava atualizar 1 canal, atualizou %', v_linhas
      using errcode = '22023';
  end if;

  update public.whatsapp_config set teto_abordagens_operador = 3;
  get diagnostics v_linhas = row_count;
  if v_linhas <> 1 then
    raise exception 'esperava 1 linha em whatsapp_config, atualizou %', v_linhas
      using errcode = '22023';
  end if;

  raise notice 'revertido: Comercial 8/30 -> 2/NULL, teto 8 -> 3';
end $$;
