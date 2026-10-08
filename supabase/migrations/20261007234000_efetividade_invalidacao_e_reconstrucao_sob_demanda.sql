-- EFETIVIDADE -- A FOTOGRAFIA PASSA A SER INVALIDADA POR EVENTO, NAO SO PELA HORA.
--
-- O QUE ESTA MIGRATION CORRIGE. A camada de leitura de 20261007230000 resolveu o
-- estouro do teto de 8s do papel `authenticated` (2026/1 ao vivo custa ~34,6 s),
-- mas trouxe uma politica de atualizacao que a gestao recusou: a Efetividade e a
-- Fila Unica ficavam ate UMA HORA mostrando estado anterior a um pagamento,
-- acordo, baixa, ajuste ou resolucao de pendencia feitos dentro do CRM. O
-- proprio comentario da Fila Unica declarava isso: "a CONTAGEM e a LISTA desta
-- fila so deixam de mostra-lo na proxima reconstrucao da rotina".
--
-- A CAMADA DE SNAPSHOT FICA. Nada aqui reabre a arquitetura: as duas tabelas de
-- fotografia, `carteira_efetividade_recalcular`, `carteira_efetividade_ler`,
-- `carteira_pendencias_itens_ler` e o cron das :40 continuam como estao. O que
-- entra e o ELO QUE FALTAVA entre "o dado mudou" e "a fotografia precisa ser
-- refeita":
--
--   acao interna do CRM  ->  marca a fotografia como desatualizada  (barato)
--   dreno de 5 em 5 min  ->  reconstroi o que esta marcado           (pesado)
--   cron das :40         ->  rede de seguranca, inalterado
--   a tela               ->  le a foto e DIZ se ha mudanca posterior a ela
--
-- POR QUE MARCAR E DRENAR, E NAO RECONSTRUIR NO CLIQUE. A reconstrucao dos tres
-- recortes custa ~60 s (2026/1 sozinho ~21 s, dentro de
-- `carteira_2026_1_classificar`, que NAO foi tocada e segue sendo a fonte da
-- verdade). Isso nao cabe nos 8 s de `authenticated` e nao pode pendurar no
-- clique de ninguem. Marcar custa um upsert de tres linhas. O padrao de
-- enfileirar barato e drenar fora da requisicao e o que este CRM ja usa em
-- `prime_extrato_pendentes_vinculo_enfileirar` / `_drenar` e em
-- `acoes_massivas_executar_agendadas`.
--
-- SEM POLLING NO FRONT E SEM REALTIME. A tela nao fica perguntando nada: ela le
-- a fotografia nos pontos que ja lia (abrir, trocar de safra, trocar de visao,
-- "Atualizar dados") e a propria leitura devolve `atualizacao_pendente`. Quem
-- reconstroi e o dreno, no banco.
--
-- NENHUMA REGRA FINANCEIRA MUDA. Os gatilhos novos nao leem valor, nao decidem
-- nada e nao escrevem em `pagamentos`, `parcelas`, `acordos` nem
-- `acordos_titulos`. Gravam uma marca de "refazer a foto" e nada mais. O
-- recalculo chama as MESMAS funcoes de sempre.
--
-- ===========================================================================
-- A DECISAO MAIS IMPORTANTE DESTA MIGRATION: A MARCA NUNCA DERRUBA O DINHEIRO
-- ===========================================================================
-- Os gatilhos rodam DENTRO da transacao que grava o pagamento ou a baixa. Se a
-- escrita da marca falhar e a excecao subir, ela aborta a transacao FINANCEIRA
-- -- ou seja: um problema na tabela de controle da Efetividade impediria uma
-- baixa de acontecer. Isso e inaceitavel, e por isso -- e SO por isso -- o
-- gatilho engole a propria falha.
--
-- O preco esta explicito e e aceitavel porque existe rede: marca perdida
-- degrada para o cron das :40, que e exatamente a defasagem que havia antes
-- desta migration. Marca perdida NUNCA produz numero errado -- produz numero
-- velho, declarado como velho pela tela. O inverso (bloquear dinheiro para
-- proteger um indicador) nao tem defesa.
--
-- ===========================================================================
-- POR QUE A INVALIDACAO E GROSSA (todos os recortes), DE PROPOSITO
-- ===========================================================================
-- Saber QUAL safra um titulo afeta exige `prime_titulo_semestre` (400.693
-- linhas) e a regua historica inteira. Isso e justamente a consulta pesada que
-- nao pode entrar num gatilho de tabela financeira. Entao a marca invalida os
-- tres recortes conhecidos.
--
-- O custo e limitado pela COALESCENCIA do dreno: N pagamentos no mesmo minuto
-- deixam UMA marca por recorte, e o dreno faz UMA reconstrucao -- nao N. Em
-- troca, a marca nunca erra por falta de informacao, que e o lado seguro.
--
-- ===========================================================================
-- GATILHO POR COMANDO, NAO POR LINHA
-- ===========================================================================
-- `FOR EACH STATEMENT`, nao `FOR EACH ROW`: a importacao do Santander insere
-- centenas de pagamentos num comando so, e por linha isso seriam centenas de
-- upserts identicos. Por comando e um, independente do volume. A marca nao
-- precisa saber quais linhas mudaram -- so que mudaram.
--
-- ===========================================================================
-- O QUE NAO E COBERTO POR EVENTO (e a tela precisa dizer)
-- ===========================================================================
-- Pagamento feito direto na ULBRA/Prime, negociacao fechada fora do CRM e
-- alteracao aplicada no banco por rotina administrativa NAO passam por estes
-- gatilhos -- nao ha evento interno para observar. Para esses, a reconciliacao
-- continua sendo o cron das :40, e a DEFASAGEM MAXIMA e de uma hora mais o
-- tempo da reconstrucao (~60 s), ou seja: ate ~61 minutos. Isso esta registrado
-- em `docs/PREMISSAS.md` e dito na tela.
--
-- NAO TOCADO: `carteira_2026_1_classificar`, `carteira_safra_situacoes`,
-- `carteira_saldo_historico_*`, `carteira_academico_perfil_*`,
-- `carteira_efetividade_recalcular`, as duas tabelas de fotografia, o fluxo
-- `EM_CONFIRMACAO`, as RPCs da Conferencia Prime e o cron `carteira_efetividade_hora`.
--
-- NAO APLICADA. Como todo `supabase/migrations/` deste projeto, este arquivo e
-- documentacao da intencao (ver supabase/ledger/DUAS-TRILHAS.md). Nao rodei
-- `apply_migration` nem `db push`.
--
-- Reversivel: supabase/rollbacks/20261007234000_efetividade_invalidacao_e_reconstrucao_sob_demanda.rollback.sql

begin;

-- ===========================================================================
-- 1. A MARCA -- uma linha por recorte, barata de escrever
-- ===========================================================================
-- Tabela propria e nao coluna em `carteira_efetividade_snapshot` porque a marca
-- precisa existir ANTES da primeira fotografia de um recorte: sem foto nao ha
-- linha lá onde carimbar, e "nunca fotografado" tambem e um pedido de
-- reconstrucao valido.
create table if not exists public.carteira_efetividade_invalidacao (
  recorte        text        not null primary key,
  invalidado_em  timestamptz not null default now(),
  motivo         text,
  origem         text,
  -- Quantas invalidacoes coalesceram desde a ultima reconstrucao. Serve para
  -- medir se a cadencia do dreno esta certa, sem precisar de log.
  pedidos        integer     not null default 1
);

comment on table public.carteira_efetividade_invalidacao is
  'Pedido de reconstrucao da fotografia da Efetividade. Escrever aqui e BARATO e nao '
  'reconstroi nada: quem reconstroi e carteira_efetividade_recalcular_pendentes(), pelo '
  'dreno de 5 em 5 min, fora da requisicao do usuario. Linha presente com '
  'invalidado_em > snapshot.gerado_em significa "a foto deste recorte esta velha".';

-- Mesma protecao das tabelas de fotografia: privilegio amplo do schema public
-- inclui TRUNCATE, e RLS nao cobre TRUNCATE. A tela nunca toca a tabela -- so
-- as funcoes SECURITY DEFINER abaixo.
alter table public.carteira_efetividade_invalidacao enable row level security;
revoke all on table public.carteira_efetividade_invalidacao from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_efetividade_invalidacao to service_role;

-- ===========================================================================
-- 2. MARCAR -- o que a acao interna chama
-- ===========================================================================
-- Os tres recortes da tela. Fixa de proposito: a lista de safras da Efetividade
-- e fechada (`SAFRAS` no front, `carteira_efetividade_recalcular` no banco) e
-- deriva-la de dado viva seria consulta dentro de gatilho.
create or replace function public.carteira_efetividade_invalidar(
  p_motivo text default null,
  p_origem text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, motivo, origem, pedidos)
  select r, now(), nullif(btrim(coalesce(p_motivo,'')), ''), nullif(btrim(coalesce(p_origem,'')), ''), 1
    from unnest(array['2024','2025','2026/1']) r
  on conflict (recorte) do update
     set invalidado_em = now(),
         motivo        = excluded.motivo,
         origem        = excluded.origem,
         pedidos       = public.carteira_efetividade_invalidacao.pedidos + 1;
end;
$function$;

comment on function public.carteira_efetividade_invalidar(text, text) is
  'Marca as fotografias da Efetividade como desatualizadas. NAO reconstroi nada e nao '
  'faz consulta pesada: e um upsert de tres linhas, seguro dentro de qualquer transacao.';

revoke all on function public.carteira_efetividade_invalidar(text, text) from public, anon;
grant execute on function public.carteira_efetividade_invalidar(text, text) to authenticated, service_role;

-- ===========================================================================
-- 3. O GATILHO -- por comando, e engolindo a propria falha
-- ===========================================================================
-- Ver o cabecalho: esta funcao roda dentro da transacao do dinheiro. A unica
-- coisa que ela nao pode fazer e abortar essa transacao.
create or replace function public.tg_carteira_efetividade_invalidar()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform public.carteira_efetividade_invalidar(
      'alteracao em ' || tg_table_name, 'GATILHO_' || upper(tg_table_name));
  exception when others then
    -- DE PROPOSITO. Marca perdida degrada para o cron das :40 -- a mesma
    -- defasagem de antes desta migration. Abortar aqui impediria uma baixa de
    -- acontecer por causa de uma tabela de indicador.
    raise warning 'invalidacao da Efetividade falhou em % (%); o cron das :40 assume.',
      tg_table_name, sqlerrm;
  end;
  return null;
end;
$function$;

comment on function public.tg_carteira_efetividade_invalidar() is
  'Gatilho AFTER ... FOR EACH STATEMENT que marca a Efetividade como desatualizada. '
  'Nao le nem escreve valor, nao decide nada e NUNCA aborta a transacao que o disparou.';

-- As quatro tabelas cujas mudancas movem a Efetividade e a Fila Unica:
-- pagamento, baixa/parcela, acordo e titulo (inclui o ajuste de valor cobravel
-- e a resolucao de pendencia, que gravam em `acordos_titulos`).
--
-- `drop` antes de `create` em vez de `if not exists` para a migration ser
-- idempotente E atualizar a funcao caso ela mude.
drop trigger if exists trg_efetividade_invalidar_pagamentos on public.pagamentos;
create trigger trg_efetividade_invalidar_pagamentos
  after insert or update or delete on public.pagamentos
  for each statement execute function public.tg_carteira_efetividade_invalidar();

drop trigger if exists trg_efetividade_invalidar_parcelas on public.parcelas;
create trigger trg_efetividade_invalidar_parcelas
  after insert or update or delete on public.parcelas
  for each statement execute function public.tg_carteira_efetividade_invalidar();

drop trigger if exists trg_efetividade_invalidar_acordos on public.acordos;
create trigger trg_efetividade_invalidar_acordos
  after insert or update or delete on public.acordos
  for each statement execute function public.tg_carteira_efetividade_invalidar();

drop trigger if exists trg_efetividade_invalidar_titulos on public.acordos_titulos;
create trigger trg_efetividade_invalidar_titulos
  after insert or update or delete on public.acordos_titulos
  for each statement execute function public.tg_carteira_efetividade_invalidar();

-- ===========================================================================
-- 4. O DRENO -- reconstroi SO o que esta marcado, fora da requisicao
-- ===========================================================================
-- Reconstroi recorte por recorte e so o que precisa: marca mais nova que a
-- fotografia, ou recorte sem fotografia nenhuma. A marca e apagada DEPOIS do
-- recalculo daquele recorte -- se o recalculo falhar, a marca fica e a proxima
-- passada tenta de novo, em vez de perder o pedido.
--
-- COALESCENCIA: a marca e lida UMA vez no inicio. Invalidacao que chegar durante
-- a reconstrucao tem `invalidado_em` maior que o que foi lido e por isso NAO e
-- apagada -- o pedido sobrevive para a passada seguinte, em vez de ser engolido
-- por uma foto que comecou antes dele.
--
-- TRADE-OFF DECLARADO: a marca e apagada quando `carteira_efetividade_recalcular`
-- RETORNA, e nao quando a fotografia efetivamente avanca. As duas coisas
-- diferem num caso: quando a conferencia interna nao fecha, aquela funcao
-- descarta a foto de proposito (nunca grava sobre uma boa) e ainda assim retorna
-- normalmente. Apagar a marca ali significa que a tela volta a dizer apenas
-- "Dados atualizados em <data antiga>", sem o aviso de pendencia.
--
-- Escolhido assim porque a alternativa e pior: manter a marca faria o dreno
-- reconstruir ~60 s a cada 5 min indefinidamente enquanto a conferencia nao
-- fechasse -- carga permanente em producao por causa de um indicador. A tela
-- continua honesta no que importa (declara a data real da foto, nunca se diz ao
-- vivo), e o descarte aparece no retorno do dreno (`descartado`) e no cron das
-- :40. Se isso virar recorrente, o caminho e consertar a conferencia, nao
-- insistir na reconstrucao.
create or replace function public.carteira_efetividade_recalcular_pendentes()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_linha  record;
  v_feitos jsonb := '[]'::jsonb;
  v_erros  jsonb := '[]'::jsonb;
begin
  for v_linha in
    select i.recorte, i.invalidado_em, i.pedidos
      from public.carteira_efetividade_invalidacao i
      left join public.carteira_efetividade_snapshot s
             on s.recorte = i.recorte and s.bloco = 'seis_linhas'
     where s.gerado_em is null or i.invalidado_em > s.gerado_em
     order by i.invalidado_em
  loop
    begin
      perform public.carteira_efetividade_recalcular(v_linha.recorte);
      -- So apaga o pedido que ESTE recalculo atendeu. Pedido que chegou depois
      -- (invalidado_em maior) fica para a proxima passada.
      delete from public.carteira_efetividade_invalidacao
       where recorte = v_linha.recorte
         and invalidado_em <= v_linha.invalidado_em;
      v_feitos := v_feitos || jsonb_build_object(
        'recorte', v_linha.recorte, 'pedidos_coalescidos', v_linha.pedidos);
    exception when others then
      -- Um recorte quebrado nao pode impedir os outros de atualizar. A marca
      -- fica, e as :40 ou a proxima passada tentam de novo.
      v_erros := v_erros || jsonb_build_object('recorte', v_linha.recorte, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', jsonb_array_length(v_erros) = 0,
                            'reconstruidos', v_feitos, 'erros', v_erros, 'em', now());
end;
$function$;

comment on function public.carteira_efetividade_recalcular_pendentes() is
  'Dreno da Efetividade: reconstroi apenas os recortes marcados como desatualizados. '
  'Roda pelo cron, fora da requisicao do usuario. Nunca e chamada pelo front.';

revoke all on function public.carteira_efetividade_recalcular_pendentes() from public, anon, authenticated;
grant execute on function public.carteira_efetividade_recalcular_pendentes() to service_role;

-- ===========================================================================
-- 5. O PEDIDO DA TELA -- o que o botao "Atualizar dados" pode chamar
-- ===========================================================================
-- O botao primeiro RELE a fotografia (`carteira_efetividade_ler`). Se a leitura
-- disser `atualizacao_pendente`, ele chama isto -- que e idempotente e barato, e
-- existe para garantir que o pedido esteja registrado mesmo que a marca tenha
-- sido perdida pelo `exception` do gatilho. NAO reconstroi nada: devolve quando
-- a reconstrucao deve sair.
create or replace function public.carteira_efetividade_solicitar_atualizacao()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  perform public.carteira_efetividade_invalidar('pedido da tela', 'BOTAO_ATUALIZAR');

  return jsonb_build_object(
    'ok', true,
    'solicitado_em', now(),
    -- O dreno roda de 5 em 5 min; as :40 sao a rede. A tela diz isso em vez de
    -- prometer imediato.
    'previsao', 'a reconstrucao sai no proximo dreno (de 5 em 5 minutos)',
    'sincrono', false);
end;
$function$;

comment on function public.carteira_efetividade_solicitar_atualizacao() is
  'Registra pedido de reconstrucao da Efetividade e volta na hora. NAO executa a '
  'consulta pesada: quem reconstroi e o dreno, fora da requisicao de 8s.';

revoke all on function public.carteira_efetividade_solicitar_atualizacao() from public, anon;
grant execute on function public.carteira_efetividade_solicitar_atualizacao() to authenticated, service_role;

-- ===========================================================================
-- 6. A LEITURA PASSA A DIZER SE A FOTO ESTA VELHA
-- ===========================================================================
-- Unica mudanca em `carteira_efetividade_ler`: acrescenta `invalidado_em` e
-- `atualizacao_pendente` ao objeto `snapshot`. O payload, a chave de recorte, o
-- portao de permissao, a validacao de bloco e o `{sem_snapshot:true}` ficam
-- identicos ao de 20261007230000 -- a tela nao pode apresentar fotografia
-- antiga como se fosse dado ao vivo, e e esta funcao que a informa.
create or replace function public.carteira_efetividade_ler(
  p_bloco    text,
  p_ano      text,
  p_semestre text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_out     jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if coalesce(p_bloco,'') not in ('seis_linhas','composicao_academica','pendencias_por_motivo') then
    raise exception 'Bloco desconhecido: %.', p_bloco using errcode = '22023';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  select s.payload
         || jsonb_build_object('snapshot', jsonb_build_object(
              'gerado_em', s.gerado_em, 'duracao_ms', s.duracao_ms, 'bloco', s.bloco,
              'invalidado_em', i.invalidado_em,
              -- A pergunta que a tela faz: mudou alguma coisa DEPOIS desta foto?
              'atualizacao_pendente', (i.invalidado_em is not null and i.invalidado_em > s.gerado_em)))
    into v_out
    from public.carteira_efetividade_snapshot s
    left join public.carteira_efetividade_invalidacao i on i.recorte = s.recorte
   where s.bloco = p_bloco and s.recorte = v_recorte;

  -- Sem fotografia a tela precisa DIZER isso, nunca cair em bloco vazio -- que
  -- e indistinguivel de "nao ha dado".
  return coalesce(v_out, jsonb_build_object('sem_snapshot', true,
                                            'bloco', p_bloco, 'recorte', v_recorte));
end;
$function$;

comment on function public.carteira_efetividade_ler(text, text, text) is
  'Leitura rapida de um bloco da Efetividade. E a UNICA porta que o front usa para os '
  'tres blocos agregados -- ele nunca chama a funcao pesada. Devolve o payload da '
  'fotografia mais `snapshot.gerado_em`, `snapshot.invalidado_em` e '
  '`snapshot.atualizacao_pendente`, ou {sem_snapshot:true}.';

revoke all on function public.carteira_efetividade_ler(text, text, text) from public, anon;
grant execute on function public.carteira_efetividade_ler(text, text, text) to authenticated, service_role;

-- ===========================================================================
-- 7. O DRENO NO CRON -- e as :40 continuam sendo a rede
-- ===========================================================================
-- De 5 em 5 minutos, nao a cada minuto: a reconstrucao de um recorte custa
-- segundos (2026/1 ~21 s) e uma cadencia de 1 min poderia emendar passadas numa
-- hora de muitos lancamentos. Com 5 min a defasagem apos acao interna cai de
-- ate 60 min para ate ~5 min mais o tempo da reconstrucao, e as invalidacoes do
-- intervalo coalescem numa reconstrucao so.
--
-- `carteira_efetividade_hora` (:40) NAO e alterado: segue reconstruindo tudo,
-- marcado ou nao, e e ele que reconcilia o que entra por fora do CRM.
select cron.schedule('carteira_efetividade_dreno', '*/5 * * * *',
                     $cron$select public.carteira_efetividade_recalcular_pendentes();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_efetividade_dreno');

-- ===========================================================================
-- 8. PROVA -- aborta se o desenho nao ficou de pe
-- ===========================================================================
do $$
declare v_n int;
begin
  select count(*) into v_n from pg_trigger
   where not tgisinternal
     and tgname in ('trg_efetividade_invalidar_pagamentos','trg_efetividade_invalidar_parcelas',
                    'trg_efetividade_invalidar_acordos','trg_efetividade_invalidar_titulos');
  if v_n <> 4 then
    raise exception 'esperados 4 gatilhos de invalidacao, encontrados %', v_n;
  end if;

  -- Gatilho por COMANDO, nunca por linha: por linha a importacao do Santander
  -- faria centenas de upserts identicos.
  select count(*) into v_n from pg_trigger
   where not tgisinternal
     and tgname like 'trg_efetividade_invalidar_%'
     and (tgtype & 1) = 1;  -- bit 1 = FOR EACH ROW
  if v_n <> 0 then
    raise exception '% gatilho(s) de invalidacao ficaram FOR EACH ROW', v_n;
  end if;

  -- O front nunca pode alcancar a funcao pesada nem o dreno.
  if has_function_privilege('authenticated',
       'public.carteira_efetividade_recalcular_pendentes()', 'execute') then
    raise exception 'authenticated nao pode executar o dreno';
  end if;
  if not has_function_privilege('authenticated',
       'public.carteira_efetividade_solicitar_atualizacao()', 'execute') then
    raise exception 'authenticated precisa poder solicitar atualizacao';
  end if;
  if has_table_privilege('authenticated', 'public.carteira_efetividade_invalidacao', 'select') then
    raise exception 'authenticated nao pode ler a tabela de invalidacao direto';
  end if;

  -- A rede de seguranca continua existindo.
  if not exists (select 1 from cron.job where jobname = 'carteira_efetividade_hora') then
    raise exception 'o cron das :40 desapareceu';
  end if;
  if not exists (select 1 from cron.job where jobname = 'carteira_efetividade_dreno') then
    raise exception 'o dreno nao foi agendado';
  end if;
end $$;

commit;
