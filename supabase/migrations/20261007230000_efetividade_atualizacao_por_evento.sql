-- POLITICA DE ATUALIZACAO da fotografia da Efetividade.
--
-- O PROBLEMA QUE A CAMADA DE DESEMPENHO CRIOU. A fotografia resolveu o teto de
-- 8s (medido: `carteira_2026_1_classificar()` sozinha leva 8.125 ms), mas trocou
-- "a tela cai" por "a tela mostra numero velho". Pagamento, acordo, baixa,
-- ajuste e resolucao da Fila Unica passavam a nao aparecer ate a proxima
-- fotografia. Decisao da gestao em 07/10/2026: isso nao serve.
--
-- O DESENHO, em tres pecas que nao se misturam:
--
--   1. MARCAR (barato, sincrono, dentro da acao do usuario). Gatilho de
--      STATEMENT -- nao de linha -- nas tabelas cuja mudanca entra na
--      Efetividade. Ele faz UM update de tres linhas e nada mais: nao calcula,
--      nao le universo, nao chama funcao de carteira. Um lote de 5.000
--      pagamentos marca uma vez, nao 5.000.
--
--   2. RECONSTRUIR (caro, assincrono, FORA da requisicao). Um cron de 5 minutos
--      pega o que esta marcado e reconstroi. Roda como `postgres`, sem teto de
--      statement. Nunca e chamado pelo clique: o botao da tela so MARCA.
--
--   3. REDE DE SEGURANCA (horaria, as :40). Reconstroi os tres recortes sem
--      perguntar se houve evento. E ela que cobre o que entra por FORA do CRM --
--      pagamento conciliado direto na Prime, ajuste feito no sistema academico --
--      porque nada dentro daqui dispara gatilho nesses casos.
--
-- POR QUE GATILHO DE STATEMENT E NAO DE LINHA: `job 38` derrubou o Postgres em
-- 24/09/2026 por trabalho por linha em tabela quente. Gatilho de statement custa
-- um update por comando, independente do tamanho do lote.
--
-- POR QUE MARCAR OS TRES RECORTES: descobrir a qual safra um pagamento pertence
-- exige justamente a consulta pesada que estamos evitando. Marcar os tres custa
-- tres linhas; descobrir custaria segundos dentro da transacao do usuario.
--
-- POR QUE O CRON DE 5 MINUTOS NAO VIRA MOEDOR: ele pega o lock por tentativa (se
-- o anterior ainda roda, desiste), e nao reconstroi recorte que foi reconstruido
-- ha menos de 4 minutos. No pior dia -- operacao continua -- isso da no maximo
-- 12 reconstrucoes por hora por recorte, e na pratica muito menos.
--
-- NADA DE POLLING NO FRONT e nada de realtime: quem verifica e o cron, no banco.
-- A tela le a fotografia quando abre, quando troca de safra e quando a pessoa
-- pede -- e so.
--
-- NENHUMA REGRA FINANCEIRA MUDA. Este arquivo nao tem SELECT sobre
-- `acordos_titulos`, `pagamentos`, `parcelas`, `alunos` nem `prime_*`.

-- A MARCA (`invalidada_em` / `invalidada_por`) e a limpeza dela no `on conflict`
-- do recalculo vivem na migration 20261007210000, junto da tabela. Aqui fica so
-- a politica: quem marca, quem atende e quando.

-- --------------------------------------------- 2. marcar (barato, por statement)
create or replace function public.carteira_efetividade_invalidar()
returns trigger
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
begin
  -- UM update, tres linhas, sem calculo. `invalidada_em` guarda a PRIMEIRA
  -- marca de um ciclo: sobrescrever a cada evento faria a marca "rejuvenescer"
  -- durante um lote e a reconstrucao nunca alcancaria o fim da fila.
  update public.carteira_efetividade_snapshot
     set invalidada_em  = coalesce(invalidada_em, now()),
         invalidada_por = coalesce(invalidada_por, TG_TABLE_NAME)
   where invalidada_em is null;
  return null;
end;
$function$;

comment on function public.carteira_efetividade_invalidar() is
  'Gatilho de STATEMENT: marca as fotografias da Efetividade como desatualizadas. Nao calcula nada.';

-- As tabelas cuja mudanca entra na Efetividade ou na Fila Unica. `casos` NAO
-- entra: o encerramento operacional nao altera as seis linhas nem a composicao,
-- e "Casos ainda pendentes" e lido ao vivo por conta propria.
do $gatilhos$
declare
  t text;
begin
  foreach t in array array['pagamentos', 'acordos', 'parcelas', 'acordos_titulos',
                           'acordo_titulo_vinculo', 'solicitacoes_confirmacao_pagamento']
  loop
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t) then
      execute format(
        'drop trigger if exists zz_efetividade_invalidar on public.%I; '
        || 'create trigger zz_efetividade_invalidar '
        || 'after insert or update or delete on public.%I '
        || 'for each statement execute function public.carteira_efetividade_invalidar();', t, t);
    end if;
  end loop;
end
$gatilhos$;

-- --------------------------- 3. pedir atualizacao (o que o BOTAO chama)
-- Leve de proposito: marca e devolve. NAO reconstroi. E o que permite o botao
-- viver dentro do teto de 8s do papel `authenticated`.
create or replace function public.carteira_efetividade_pedir_atualizacao(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  update public.carteira_efetividade_snapshot
     set invalidada_em  = coalesce(invalidada_em, now()),
         invalidada_por = coalesce(invalidada_por, 'tela')
   where (p_recorte is null or recorte = p_recorte)
     and invalidada_em is null;
  get diagnostics v_n = row_count;

  -- `pedido` diz que a fila recebeu, nunca que o numero ja mudou. A tela tem de
  -- continuar mostrando a data da fotografia que ela TEM.
  return jsonb_build_object('pedido_em', now(), 'marcadas', v_n,
                            'reconstroi_em_ate_minutos', 5);
end;
$function$;

revoke all on function public.carteira_efetividade_pedir_atualizacao(text) from public, anon;
grant execute on function public.carteira_efetividade_pedir_atualizacao(text) to authenticated, service_role;

-- ------------------------------------- 4. reconstruir o que esta marcado (cron)
create or replace function public.carteira_efetividade_atender_pedidos()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
-- Roda como `postgres` pelo cron, mas o SET deixa explicito que esta funcao e a
-- pesada -- e que ela NUNCA deve ser chamada de dentro de uma requisicao.
set statement_timeout to '240s'
as $function$
declare
  r         record;
  v_feitos  jsonb := '[]'::jsonb;
begin
  if not (coalesce(auth.role(),'') = 'service_role'
          or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- Se a rodada anterior ainda esta reconstruindo, esta desiste. Duas
  -- reconstrucoes concorrentes gastariam o dobro para gravar a mesma coisa.
  if not pg_try_advisory_xact_lock(hashtext('carteira_efetividade_atender')) then
    return jsonb_build_object('ja_em_andamento', true, 'verificado_em', now());
  end if;

  for r in
    select s.recorte
      from public.carteira_efetividade_snapshot s
     where s.bloco = 'situacoes'
       and s.invalidada_em is not null
       -- piso de 4 minutos entre reconstrucoes do mesmo recorte: num dia de
       -- operacao continua a marca volta na hora, e sem o piso o cron viraria
       -- um moedor reconstruindo sem parar.
       and s.gerado_em < now() - interval '4 minutes'
     order by s.invalidada_em
  loop
    perform public.carteira_efetividade_snapshot_recalcular(r.recorte);
    v_feitos := v_feitos || to_jsonb(r.recorte);
  end loop;

  return jsonb_build_object('verificado_em', now(), 'reconstruidos', v_feitos);
end;
$function$;

revoke all on function public.carteira_efetividade_atender_pedidos() from public, anon;
grant execute on function public.carteira_efetividade_atender_pedidos() to service_role;

-- ------------------------------------------------------------------ 5. as duas rotinas
-- A rede de seguranca passa a ser HORARIA, as :40. Era de 20 em 20 minutos; com
-- o gatilho marcando e o cron de 5 minutos atendendo, a fotografia deixa de
-- depender dela para o que acontece DENTRO do CRM. O preco e que o movimento
-- que entra por FORA -- pagamento conciliado na Prime, ajuste academico -- passa
-- a ter defasagem de ate 60 minutos, contra os 20 de antes.
select cron.schedule('carteira_efetividade_rede_de_seguranca', '40 * * * *',
                     $cron$select public.carteira_efetividade_snapshot_recalcular();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_efetividade_rede_de_seguranca');

-- O atendedor dos pedidos: de 5 em 5 minutos. Quando nada esta marcado ele sai
-- em milissegundos -- a consulta e um index scan de tres linhas.
select cron.schedule('carteira_efetividade_atender_pedidos', '*/5 * * * *',
                     $cron$select public.carteira_efetividade_atender_pedidos();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_efetividade_atender_pedidos');
