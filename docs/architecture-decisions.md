# Decisões de arquitetura

## 2026-08-06 — Identidade, sincronização e cofre itinerante

Status: etapas 1 e 2 implementadas; etapa 3 pendente.

### Identidade

- A conta corporativa Microsoft 365 será a identidade principal do usuário.
- O aplicativo deverá oferecer uma sessão persistente e tentar renovar o acesso silenciosamente.
- Uma nova autenticação interativa será solicitada quando a Microsoft, o MFA ou as políticas do tenant exigirem.

### Dados locais e Microsoft 365

- Contatos e calendário terão o Exchange como fonte sincronizada de dados.
- O armazenamento local continuará sendo usado como cache rápido e para funcionamento offline: SQLite para contatos e o armazenamento local já existente para calendário.
- Alterações locais são enviadas em segundo plano e as coleções remotas são consultadas de forma paginada, sem bloquear a interface.

### Cofre de senhas entre dispositivos

- O conteúdo do cofre será sincronizado somente de forma criptografada.
- Em um computador novo, o usuário deverá informar uma senha mestra ou um código de recuperação uma única vez.
- A senha mestra não será enviada nem armazenada pela Microsoft.
- Depois do primeiro desbloqueio, a chave local poderá ser protegida pelo Windows para facilitar os próximos acessos no mesmo computador.
- Não será utilizado um serviço central que consiga descriptografar automaticamente o cofre do usuário.

### Etapas aprovadas

1. Login Microsoft automático e persistente. **Implementado.**
2. Sincronização bidirecional de contatos e calendário com Exchange. **Implementado.**
3. Cofre criptografado itinerante, com desbloqueio inicial por senha mestra ou código de recuperação em cada computador novo.

### Observação para a arquitetura do DMH Portal

A ordem acima será revisada antes da implementação caso o aplicativo seja transformado em um portal modular. Nesse caso, a fundação do portal, o isolamento de módulos e o modelo de autorização deverão ser definidos primeiro, para que identidade e sincronização não precisem ser reconstruídas posteriormente.
