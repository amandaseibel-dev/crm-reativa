-- PAUSA O CAMINHO AUTOMATICO DE CONSULTA AO PORTADOR.
--
-- DIRETRIZ DE NEGOCIO, 15/09/2026. O motor tecnico esta instalado e verificado,
-- mas a gestao nao considera o ciclo concluido enquanto o CRM nao souber
-- exatamente o que foi negociado em cada acordo. Enquanto o mapeamento da
-- estrutura do acordo nao existir, o caminho automatico novo fica desligado.
--
-- O QUE ESTA MIGRATION FAZ, e so isso:
--   1. cria a etapa `consulta_portador` em `fluxo_pagamentos_config`, DESLIGADA;
--   2. poe uma saida antecipada no disparador, lendo essa etapa.
--
-- O QUE ELA NAO FAZ: nao reabre titulo, nao mexe nos 8.999 historicos, nao
-- altera o teto de 5, nao reseta `consulta_portador_em`, nao remove nenhuma
-- funcao da #379/#380 e nao toca em `baixa_pelo_relatorio`, `amarrar_boleto`,
-- `pos_importacao` nem `sinalizar_duplicado`.
--
-- POR QUE UMA ETAPA, E NAO UM RETURN CRU. Substituir o corpo do disparador por
-- um `return` perderia o corpo -- e religar exigiria outra migration, com o
-- risco de reescrever 130 linhas de memoria. Com a etapa, o corpo fica intacto
-- e religar e um UPDATE de uma linha. A mecanica ja existe: e a mesma que
-- `fluxo_pagamentos_rodar` usa para as outras seis etapas.
--
-- NAO EXISTIA KILL-SWITCH que alcancasse este disparador -- foi conferido antes
-- de escrever: ele nao lia configuracao nenhuma, e as tabelas `configuracoes`,
-- `parametros_operacao` e `fluxo_pagamentos_config` sao lidas apenas por outras
-- funcoes. Por isso a flag precisou nascer aqui.
--
-- EFEITO: `conciliacao_reprocessar` continua rodando e classificando os
-- pendentes normalmente; so o disparo externo para. O disparador tem UM unico
-- chamador (`conciliacao_reprocessar`) e NENHUMA tela o chama -- conferido em
-- `src/`. Entao pausar aqui neutraliza o caminho automatico inteiro, e nada
-- alem dele.

insert into public.fluxo_pagamentos_config (etapa, ligado, observacao)
values ('consulta_portador', false,
        'pausado em 15/09/2026 por diretriz de negocio: sem mapeamento da estrutura do acordo, o caminho automatico de consulta/liquidacao/fallback 166 nao roda. Religar exige autorizacao expressa da gestao.')
on conflict (etapa) do update
   set ligado = false,
       observacao = excluded.observacao;

create or replace function public.conciliacao_consultar_portador_pendentes(
  p_limite int default 5
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_url text; v_token text; v_req bigint; v_carga jsonb;
  v_n int := 0; v_casos jsonb := '[]'::jsonb; r record;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Consulta pontual ao portador e da gestao ou da rotina.' using errcode = '42501';
  end if;

  -- PAUSA DE NEGOCIO (15/09/2026). A gestao nao considera o ciclo concluido
  -- enquanto o CRM nao souber o que foi negociado no acordo: valor original,
  -- desconto, encargos, entrada, parcelas, vencimentos, saldo. Ate la, o
  -- caminho automatico novo fica desligado.
  --
  -- ESTA SAIDA VEM ANTES DE TUDO QUE ESCREVE OU SAI DA CASA: antes do disjuntor
  -- de carga, antes do carimbo de `consulta_portador_em`, antes do net.http_post
  -- e antes de qualquer chamada a Edge. Pausado, este disparador nao tem efeito
  -- colateral nenhum.
  --
  -- E A PAUSA E UM DADO, NAO CODIGO: `fluxo_pagamentos_config.consulta_portador`
  -- e a mesma mecanica de etapa que `fluxo_pagamentos_rodar` ja usa desde
  -- sempre. Religar e um UPDATE -- e exige autorizacao expressa da gestao.
  if not coalesce((select ligado from public.fluxo_pagamentos_config
                    where etapa = 'consulta_portador'), false) then
    return jsonb_build_object('pulou', 'PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS');
  end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    return jsonb_build_object('pulou', 'sistema sob carga');
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    return jsonb_build_object('pulou', 'segredo ausente no Vault');
  end if;

  for r in
    select p.id,
           coalesce(nullif(p.matricula,''), f.matricula_recebida) as registration,
           p.titulo_numero
      from public.pagamentos p
      join public.fila_pagamento_sem_vinculo f
        on f.pagamento_id = p.id and f.decisao is null
     where (
             -- a pendencia de sempre
             (p.status_conciliacao = 'AGUARDANDO_ACORDO' and f.evidencia_origem is null)
             -- SEGUNDA CHANCE, CURTA E QUE FECHA SOZINHA.
             --
             -- `ACORDO_CONFIRMADO_SEM_ESTRUTURA` afirma que houve negociacao --
             -- e isso continua verdade. Mas o extrato da Prime pode passar a
             -- mostrar o titulo-mae liquidado depois, e ai existe resposta
             -- melhor. Sem esta janela o caso ficaria congelado para sempre.
             --
             -- O QUE O CODIGO GARANTE, e so isso: janela FINITA de 72h a
             -- partir de `conciliacao_em`, que agora so anda quando o ESTADO
             -- muda, mais no maximo UMA tentativa por 24h por caso. Em +72h a
             -- janela fecha e o caso para de ser consultado, para sempre.
             --
             -- No fluxo automatico normal isso produz DUAS reconsultas (~+24h e
             -- ~+48h), porque a confirmacao vem logo depois de um disparo e
             -- `consulta_portador_em` esta fresca. Mas nao e invariante: num
             -- caminho excepcional -- `consulta_portador_em` nula ou antiga,
             -- por confirmacao vinda da rodada em lote e nao do disparador --
             -- cabe uma tentativa adicional imediata. O limite continua sendo o
             -- relogio, nao uma contagem, e de proposito: contar exigiria
             -- coluna nova para um ganho que a janela ja entrega.
             --
             -- Nao exige `evidencia_origem is null` aqui: um caso confirmado TEM
             -- evidencia -- e essa e justamente a condicao que o traz de volta.
             or (p.status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'
                 and p.conciliacao_em > now() - interval '72 hours')
           )
       -- NAO exclui quem ja tem linha local do 166. O espelho prova negociacao,
       -- nao ausencia de estrutura -- e a tentativa oficial precisa acontecer
       -- antes do fallback. O teto de uma por dia por caso e que segura o volume.
       and coalesce(nullif(p.matricula,''), f.matricula_recebida) ~ '^\d{6,12}$'
       and (f.consulta_portador_em is null
            or f.consulta_portador_em < now() - interval '24 hours')
     order by p.data_pagamento, p.id
     limit greatest(coalesce(p_limite, 5), 0)
  loop
    -- A marca vem ANTES: se a chamada falhar, o caso nao volta na proxima hora.
    -- E SO ISSO que ela significa -- frequencia, uma tentativa por dia por caso.
    -- Nao e resultado: quem responde "o que a API disse" e
    -- `consulta_estrutura_resultado`, gravado pela Edge DEPOIS da chamada.
    update public.fila_pagamento_sem_vinculo
       set consulta_portador_em = now()
     where pagamento_id = r.id;

    select net.http_post(
      url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
      headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
      body := jsonb_build_object('registration', r.registration, 'pagamento_id', r.id,
                                 'titulo_numero', r.titulo_numero),
      timeout_milliseconds := 60000) into v_req;

    v_n := v_n + 1;
    v_casos := v_casos || jsonb_build_object('pagamento_id', r.id,
                            'registration', r.registration, 'requisicao', v_req);
  end loop;

  return jsonb_build_object('disparados', v_n, 'limite', p_limite, 'casos', v_casos);
end;
$fn$;

comment on function public.conciliacao_consultar_portador_pendentes(int) is
  'Disparador do caminho ao vivo. Consulta AGUARDANDO_ACORDO sem evidencia e, por no maximo 72h a partir de conciliacao_em, tambem ACORDO_CONFIRMADO_SEM_ESTRUTURA. O que o codigo garante na segunda chance e janela finita de 72h mais no maximo uma tentativa por 24h por caso -- no fluxo normal isso da duas reconsultas, mas nao e invariante: com consulta_portador_em nula ou antiga cabe uma tentativa adicional. Depois de 72h a janela fecha sozinha. Usa consulta_portador_em SOMENTE como controle de frequencia. Chamado pela rodada horaria -- nunca pelo gatilho de INSERT.';

revoke all on function public.conciliacao_consultar_portador_pendentes(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PROVA
-- ---------------------------------------------------------------------------

do $prova$
declare v_src text;
begin
  if coalesce((select ligado from public.fluxo_pagamentos_config
                where etapa='consulta_portador'), true) then
    raise exception 'a etapa consulta_portador nao ficou desligada';
  end if;

  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='conciliacao_consultar_portador_pendentes';
  if v_src not ilike '%PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS%' then
    raise exception 'o disparador nao tem a saida de pausa';
  end if;

  -- a saida tem de vir ANTES de tudo que escreve ou sai da casa
  if position('PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS' in v_src)
     > position('sistema_sob_carga' in v_src) then
    raise exception 'a pausa vem depois do disjuntor de carga';
  end if;
  if position('PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS' in v_src)
     > position('set consulta_portador_em = now()' in v_src) then
    raise exception 'a pausa vem depois do carimbo de consulta_portador_em';
  end if;
  -- a CHAMADA, nao a mencao: o proprio comentario da guarda cita net.http_post
  -- para explicar o que ela evita, e comparar contra a mencao inverteria a ordem.
  if position('PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS' in v_src)
     > position('select net.http_post(' in v_src) then
    raise exception 'a pausa vem depois da chamada externa';
  end if;

  -- e o resto do fluxo continua ligado
  if not coalesce((select ligado from public.fluxo_pagamentos_config
                    where etapa='baixa_pelo_relatorio'), false) then
    raise exception 'baixa_pelo_relatorio foi desligada -- nao era para';
  end if;
end $prova$;
