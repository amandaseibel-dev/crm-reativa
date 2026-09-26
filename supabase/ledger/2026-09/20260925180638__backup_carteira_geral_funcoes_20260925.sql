create table public._backup_carteira_geral_funcoes_20260925 as
select n.nspname as schema, p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_functiondef(p.oid) as definicao_antes,
       now() as capturado_em
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('nivelamento_automatico_gestao','calibragem_simular_nivelamento_impl',
       'reforcar_teto_operadores','nivelar_medias_progressivo','reposicao_carteira_processar',
       'assumir_caso_livre','assumir_caso_livre_aluno','sistema_assumir_atendimento',
       'assumir_atendimento_aluno','sistema_assumir_receptivo','fila_receptivo_heartbeat',
       '_aluno_segue_dono_do_acordo','casos_elegiveis_liberacao_fidelizacao',
       'atribuir_responsavel_por_acordo');

alter table public._backup_carteira_geral_funcoes_20260925 enable row level security;
revoke all on table public._backup_carteira_geral_funcoes_20260925 from anon, authenticated;
