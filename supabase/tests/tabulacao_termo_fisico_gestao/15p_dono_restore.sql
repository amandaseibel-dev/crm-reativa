-- RESTAURAÇÃO (postgres): devolve os objetos ao dono postgres. Roda sempre.
\set ON_ERROR_STOP on
alter table public.termo_fisico_contencao owner to postgres;
alter function public.usuario_e_gestao() owner to postgres;
alter function public.app_usuario_ativo() owner to postgres;
alter function public.aluno_movimentacao_tabulacao_so_gestao() owner to postgres;
alter function public.registrar_administrativo_termo_fisico(text, text) owner to postgres;
