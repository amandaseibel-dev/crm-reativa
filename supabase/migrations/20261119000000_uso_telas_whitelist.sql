-- USO DE TELAS — WHITELIST DE ROTAS (19/11/2026).
--
-- POR QUE EXISTE. A RPC `registrar_acesso_tela` já validava formato com
-- regex, mas não sabia quais rotas o CRM realmente tem. Uma rota bem
-- formatada mas inexistente (ex: "/rota-inventada") passava no banco sem
-- gerar dado útil. Este complemento adiciona uma tabela de rotas cadastradas
-- e obriga a RPC a rejeitá-la silenciosamente quando ela não estiver na lista.
--
-- O QUE FAZ.
--   • `uso_telas_rotas_validas`: uma linha por rota registrada no App.jsx.
--     Sem RLS policy — acesso exclusivo via RPC `security definer`.
--   • `registrar_acesso_tela` (CREATE OR REPLACE): mantém toda a lógica
--     anterior (email do JWT, regex de formato) e acrescenta uma checagem
--     contra a tabela. Rotas ausentes são ignoradas silenciosamente.
--
-- SEGURANÇA.
--   • `revoke all from anon, authenticated` antes de ligar a RLS na tabela
--     nova — mesmo padrão de `uso_telas`.
--   • A RPC continua `security definer` com `search_path = 'public'`.
--   • `CREATE OR REPLACE` em `registrar_acesso_tela` reconstrói o grant;
--     o bloco de grant/revoke abaixo é repetido por isso.
--
-- NÃO altera fila, carteira, pagamentos nem nenhuma regra operacional.

-- ── TABELA DE ROTAS VÁLIDAS ───────────────────────────────────────────────

create table if not exists public.uso_telas_rotas_validas (
  rota text primary key
);

comment on table public.uso_telas_rotas_validas is
  'Lista das rotas do CRM que devem ser rastreadas. Alimentada pela migration; lida apenas pela RPC registrar_acesso_tela (security definer).';

revoke all on public.uso_telas_rotas_validas from anon, authenticated;
alter  table public.uso_telas_rotas_validas enable row level security;
-- Sem policy: acesso exclusivo via RPC security definer.

-- ── ROTAS CADASTRADAS (espelho do ROTAS_VALIDAS em App.jsx) ───────────────

insert into public.uso_telas_rotas_validas (rota) values
  ('/'),
  ('/a-entrar'),
  ('/acoes-massivas'),
  ('/acordos-duplicados'),
  ('/acordos-operador'),
  ('/acordos-sem-vinculo'),
  ('/aluno'),
  ('/avisos'),
  ('/base-analitica'),
  ('/borderos'),
  ('/calibragem'),
  ('/calibragem-detalhada'),
  ('/carteira-2026-1'),
  ('/carteira-geral'),
  ('/central-pagamentos'),
  ('/central-ulbra'),
  ('/central-whatsapp'),
  ('/conferencia-prime'),
  ('/configuracoes'),
  ('/crm'),
  ('/diagnostico-portador-166'),
  ('/dre'),
  ('/efetividade'),
  ('/elogios-atendimento'),
  ('/envio-gmail'),
  ('/executivo'),
  ('/exportar-contatos'),
  ('/fechamento-remuneracao'),
  ('/ferramentas'),
  ('/fila-acordos'),
  ('/fila-operacional'),
  ('/fila-unica-confirmacao'),
  ('/financeiro'),
  ('/financeiro-hub'),
  ('/financeiro-operadores'),
  ('/historico-recuperacao'),
  ('/importacoes'),
  ('/importar-academico'),
  ('/importar-acordos'),
  ('/importar-recuperacao'),
  ('/leads-whatsapp'),
  ('/log-nivelamento'),
  ('/mensageria-ulbra'),
  ('/meu-dashboard'),
  ('/meu-perfil'),
  ('/minha-agenda'),
  ('/minha-fila'),
  ('/minha-fila-pagamentos'),
  ('/minhas-solicitacoes'),
  ('/pagamentos-sem-aluno'),
  ('/painel-adm'),
  ('/painel-carteira'),
  ('/painel-geral'),
  ('/portal-operacional'),
  ('/preventivo'),
  ('/produtividade'),
  ('/projecao-hora-a-hora'),
  ('/quitacao-sugerida'),
  ('/relatorio-receptivo'),
  ('/relatorios'),
  ('/relatorios-2026-1-sem-negociacao'),
  ('/revisao-cadastral'),
  ('/revisao-prime'),
  ('/saude-completa-carteira'),
  ('/saude-da-base'),
  ('/sugestoes-recebidas'),
  ('/taxa-conversao'),
  ('/termos-adm'),
  ('/tv-mensagem'),
  ('/ulbra-diagnostico'),
  ('/uso-crm'),
  ('/usuarios'),
  ('/vincular-operadores')
on conflict do nothing;

-- ── RPC: registrar acesso (write) — versão com whitelist ─────────────────
-- CREATE OR REPLACE: mantém a assinatura exata. Recria os grants abaixo.

create or replace function public.registrar_acesso_tela(p_rota text)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_email text;
  v_rota  text;
begin
  -- Identidade do JWT; nunca vem do parâmetro.
  v_email := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  if v_email is null then return; end if;

  -- Formato básico: começa com '/' e só tem chars de URL seguros.
  if p_rota is null or btrim(p_rota) = '' then return; end if;
  if length(p_rota) > 300 then return; end if;
  v_rota := btrim(p_rota);
  if v_rota !~ '^/[a-zA-Z0-9/_\-\.]*$' then return; end if;

  -- Whitelist: só rotas cadastradas na tabela.
  if not exists (select 1 from public.uso_telas_rotas_validas where rota = v_rota) then
    return;
  end if;

  insert into public.uso_telas (usuario_email, rota, dia, acessos)
  values (v_email, v_rota, current_date, 1)
  on conflict (usuario_email, rota, dia) do update
    set acessos = public.uso_telas.acessos + 1;
end;
$function$;

-- CREATE OR REPLACE reconstrói os grants padrão do schema; repetir explicitamente.
revoke all on function public.registrar_acesso_tela(text) from public;
grant  execute on function public.registrar_acesso_tela(text) to authenticated;
