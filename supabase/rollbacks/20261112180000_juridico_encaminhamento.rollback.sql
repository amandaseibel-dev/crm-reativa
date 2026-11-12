-- ROLLBACK de 20261112180000_juridico_encaminhamento.sql
--
-- PITR nao esta habilitado: rollback nao e restore. Este arquivo:
--   1. RECUSA rodar se houver caso com cobranca bloqueada pela aba. Levante antes
--      (juridico_caso_remover alcanca APROVADO) ou decida com a gestao o destino
--      dos ja enviados. Nao ha como desfazer o envio ao financeiro por aqui.
--   2. guarda copia das cinco tabelas em `_backup_juridico_*_20261112` (RLS ligada,
--      sem grant) antes de remover;
--   3. solta, nesta ordem: triggers nas tabelas do sistema, funcoes (lista
--      explicita de 26 assinaturas), tabelas, sequences. Nenhum titulo, parcela
--      ou acordo e tocado -- a migration tambem nao os tocou.

begin;

do $guarda$
declare v_n int;
begin
  select count(*) into v_n
    from public.juridico_casos
   where status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO');
  if v_n > 0 then
    raise exception 'rollback juridico: % caso(s) com cobranca bloqueada por esta aba. Levante os bloqueios antes.', v_n;
  end if;
end
$guarda$;

create table public._backup_juridico_lotes_20261112 as table public.juridico_lotes;
create table public._backup_juridico_casos_20261112 as table public.juridico_casos;
create table public._backup_juridico_casos_titulos_20261112 as table public.juridico_casos_titulos;
create table public._backup_juridico_historico_20261112 as table public.juridico_historico;
create table public._backup_juridico_documentos_20261112 as table public.juridico_documentos;
alter table public._backup_juridico_lotes_20261112 enable row level security;
alter table public._backup_juridico_casos_20261112 enable row level security;
alter table public._backup_juridico_casos_titulos_20261112 enable row level security;
alter table public._backup_juridico_historico_20261112 enable row level security;
alter table public._backup_juridico_documentos_20261112 enable row level security;
revoke all on public._backup_juridico_lotes_20261112, public._backup_juridico_casos_20261112,
              public._backup_juridico_casos_titulos_20261112, public._backup_juridico_historico_20261112,
              public._backup_juridico_documentos_20261112
  from public, anon, authenticated;

-- 1. gatilhos nas tabelas do sistema (dependem das funcoes)
drop trigger if exists trg_juridico_guarda_bloqueio on public.alunos;
drop trigger if exists trg_juridico_guarda_bloqueio on public.casos;
drop trigger if exists trg_juridico_guarda_caso_novo on public.casos;
drop trigger if exists trg_juridico_so_anexa_historico on public.juridico_historico;
drop trigger if exists trg_juridico_so_anexa_documentos on public.juridico_documentos;
drop trigger if exists trg_juridico_so_anexa_truncate_historico on public.juridico_historico;
drop trigger if exists trg_juridico_so_anexa_truncate_documentos on public.juridico_documentos;

-- 2. funcoes: lista explicita, 26 assinaturas (conferidas pela migration)
drop function public._juridico_exigir_gestao();
drop function public._juridico_grupo(text);
drop function public._juridico_pagamento_nao_baixado(uuid);
drop function public._juridico_conferencia(uuid);
drop function public._juridico_pendencias(public.juridico_casos,jsonb);
drop function public._juridico_divergencias(public.juridico_casos);
drop function public._juridico_registrar(uuid,uuid,text,jsonb,text);
drop function public._juridico_candidatos(integer,integer,integer,text[],uuid[]);
drop function public._juridico_lote_payload(uuid);
drop function public._juridico_desbloquear(public.juridico_casos);
drop function public._juridico_guarda_bloqueio();
drop function public._juridico_guarda_caso_novo();
drop function public._juridico_so_anexa();
drop function public.juridico_candidatos(integer,integer,integer,text[]);
drop function public.juridico_lote_gerar(integer,integer,integer,text[],text);
drop function public.juridico_caso_substituir(uuid,text);
drop function public.juridico_caso_remover(uuid,text);
drop function public.juridico_caso_documento_vincular(uuid,text,text,text);
drop function public.juridico_caso_autorizar_documento(uuid,text);
drop function public.juridico_caso_aprovar_acordo_ativo(uuid,text);
drop function public.juridico_caso_aprovar(uuid);
drop function public.juridico_lote_exportar(uuid);
drop function public.juridico_lote_enviar_financeiro(uuid);
drop function public.juridico_casos_confirmar_juridico(uuid[],date,text);
drop function public.juridico_painel();
drop function public.juridico_varrer_alertas();

-- 3. tabelas e sequences
drop table public.juridico_documentos;
drop table public.juridico_historico;
drop table public.juridico_casos_titulos;
drop table public.juridico_casos;
drop table public.juridico_lotes;
drop sequence public.juridico_protocolo_seq;

commit;
