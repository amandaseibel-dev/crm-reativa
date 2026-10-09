-- ============================================================================
-- DRE: quem le e a gerencia e a diretoria -- nao a allowlist de gestao
-- ----------------------------------------------------------------------------
-- Amanda, 03/09/2026: "a Angela tem acesso; a Fernanda que nao tem".
--
-- Na TELA ja era assim: o menu e a rota /dre so abrem para amanda + perfil
-- diretoria. No BANCO nao era. dre_snapshot() usa snapshot_gerencial_pode_ler(),
-- que e "allowlist de gestao OU diretoria" -- e a allowlist de gestao existe
-- para a VISAO EXECUTIVA, entao inclui cobranca04 e cobranca07.
-- Medido em prod: chamando dre_snapshot(2026) direto pela API, cobranca04 e
-- cobranca07 recebiam os 12 meses e as 129 linhas de folha_detalhe -- ou seja,
-- os salarios nominais de todo mundo. Nao aparecia na tela; bastava a chamada.
--
-- Correcao: o DRE ganha portao PROPRIO, dre_pode_ler() = gerencia (Amanda) +
-- diretoria + server-side. A Visao Executiva NAO muda: ela segue em
-- snapshot_gerencial_pode_ler(), com cobranca04 e cobranca07 -- e e para isso
-- que aquele portao foi feito. O que muda e so o DRE parar de pegar carona nele.
--
-- Escrita: atualizar_snapshots_gerenciais() segue aceitando a allowlist de
-- gestao. A Fernanda continua podendo clicar "Atualizar projecao" e regerar o
-- DRE; ela manda calcular sem ver o resultado, que nao volta na resposta.
-- Reversivel: supabase/rollbacks/20260903400000_*.rollback.sql
-- ============================================================================

begin;

create or replace function public.dre_pode_ler()
returns boolean language sql stable security definer set search_path = public as $fn$
  select lower(coalesce(auth.jwt() ->> 'email','')) = 'amanda.seibel@aelbra.com.br'
      or public.usuario_e_diretoria()
      or auth.jwt() is null;  -- server-side / cron
$fn$;
revoke all on function public.dre_pode_ler() from public;
grant execute on function public.dre_pode_ler() to authenticated;
comment on function public.dre_pode_ler() is
  'Quem le o DRE: gerencia (Amanda) + perfil diretoria. NAO e a allowlist de gestao -- essa e da Visao Executiva, em snapshot_gerencial_pode_ler().';

create or replace function public.dre_snapshot(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_payload jsonb;
begin
  if not public.dre_pode_ler() then
    raise exception 'Acesso negado: o DRE e da gerencia e da diretoria.' using errcode = '42501';
  end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  -- "sem 'meses'" cobre o snapshot nulo (1a vez) e o envenenado que ficou de
  -- antes da migration 20260903300000. Nos dois casos: recalcula.
  if v_payload is null or not (v_payload ? 'meses') then
    v_payload := public._dre_dados_calcula(p_ano);
    if v_payload ? 'meses' then
      insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
        on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
    end if;
  end if;
  return v_payload;
end; $fn$;

commit;
