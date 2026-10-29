-- PREPARA A SEGUNDA CHANCE, ANTES DA 20260915120000.
--
-- POR QUE ESTA MIGRATION EXISTE. A 20260915120000 tem o bloco `DO $prova$`
-- ANTES da secao que redefine `conciliacao_consultar_portador_pendentes` com a
-- janela de 72h. Aplicada sozinha, ela aborta na propria prova:
--
--   ERROR: P0001: o disparador nao da segunda chance ao estado confirmado
--
-- E foi o que aconteceu em 15/09/2026, em producao. A migration e transacional:
-- nada entrou, e a prova fez exatamente o trabalho dela -- falhar caro e cedo.
--
-- POR QUE NAO SE CORRIGE O ARQUIVO. Ele ja esta no `main`, e a governanca do
-- repo trata migration na base como IMUTAVEL -- mesmo nao tendo sido aplicada.
-- A catraca bloqueia os tres estados: alterar (I1), apagar (I2) e renomear
-- (I3). Reescrever historico de migration e justamente o que ela impede.
--
-- ENTAO A CORRECAO E DE ORDEM, NAO DE CONTEUDO: esta migration ordena ANTES
-- (115959 < 120000) e instala o disparador na forma FINAL. A sequencia fica:
--
--   20260914190000  motor + disparador sem janela
--   20260915115959  <- esta: disparador COM a janela de 72h
--   20260915120000  roda intacta; ao chegar no DO $prova$ o disparador ja esta
--                   correto, e a secao 7 dela reaplica o MESMO corpo -- que e
--                   idempotente por ser `create or replace` do identico.
--
-- O CORPO ABAIXO E COPIA EXATA da secao 7 da 20260915120000, extraida do
-- proprio arquivo. Nao ha aqui nenhuma outra logica: nem coluna, nem trava, nem
-- liquidador, nem identidade. So o disparador, com o mesmo comment e o mesmo
-- revoke.

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
