-- Remove a fila de acordos sem vínculo. A tela /acordos-sem-vinculo deixa de
-- carregar -- retirar a rota do App.jsx junto.
drop function if exists public.acordos_sem_vinculo_fila();
