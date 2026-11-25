import { ActionIcon, Anchor, Box, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useToasts } from '../components/toasts.js';
import { ServerScope, useServers, type ServerEntry } from '../servers/index.js';
import type { ProjectEntry } from './fetch-projects.js';
import { ProjectDialogs, type ProjectDialog } from './ProjectDialogs.js';
import { useProjectFilter } from './project-filter.js';
import { useProjects } from './use-projects.js';

const newProjectId = (): string => crypto.randomUUID();

function ProjectRow(props: {
  readonly project: ProjectEntry;
  readonly current: boolean;
  readonly onChoose: () => void;
  readonly onRename: () => void;
  readonly onIcon: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const { project } = props;
  return (
    <Group
      component="li"
      justify="space-between"
      wrap="nowrap"
      gap="xs"
      style={{ listStyle: 'none' }}
    >
      <Anchor
        component={Link}
        to="/"
        onClick={props.onChoose}
        aria-current={props.current ? 'true' : undefined}
        fw={props.current ? 700 : undefined}
      >
        {project.icon === null ? null : <span aria-hidden="true">{project.icon} </span>}
        {project.label}
      </Anchor>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={`Actions ${project.label}`}>
            <span aria-hidden="true">⋯</span>
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={props.onRename}>Rename</Menu.Item>
          <Menu.Item onClick={props.onIcon}>Change icon</Menu.Item>
          {project.isDefault ? null : <Menu.Item onClick={props.onArchive}>Archive</Menu.Item>}
          {project.isDefault ? null : (
            <Menu.Item color="red" onClick={props.onDelete}>
              Delete
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function ServerProjects(props: {
  readonly server: ServerEntry;
  readonly named: boolean;
  readonly onNavigate?: () => void;
}): ReactNode {
  const { server, named } = props;
  const data = useProjects();
  const { select } = useServers();
  const { projectId, choose } = useProjectFilter();
  const toasts = useToasts();
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const guarded = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      toasts.push(
        error instanceof Error && error.message !== '' ? error.message : 'The change failed.',
      );
      throw error;
    }
  };
  const projects = data?.projects ?? [];
  const live = projects.filter((project) => !project.archived);
  const archived = projects.filter((project) => project.archived);
  const picked = (id: string | null) => (): void => {
    choose(id);
    select(server.id);
    props.onNavigate?.();
  };

  const askDelete = async (project: ProjectEntry): Promise<void> => {
    if (data === null) return;
    try {
      setDialog({ kind: 'delete', project, hasTasks: await data.actions.inUse(project.id) });
    } catch (error) {
      toasts.push(error instanceof Error ? error.message : 'The project could not be checked.');
    }
  };

  return (
    <Stack role="group" aria-label={server.name} gap={4}>
      {named ? (
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          {server.name}
        </Text>
      ) : null}
      {data === null ? null : (
        <>
          <Button
            variant="default"
            aria-label={named ? `New project in ${server.name}` : 'New project'}
            onClick={() => setDialog({ kind: 'create' })}
          >
            New project
          </Button>
          <Stack component="ul" gap={4} p={0} m={0}>
            <Group component="li" style={{ listStyle: 'none' }}>
              <Anchor
                component={Link}
                to="/"
                onClick={picked(null)}
                aria-current={projectId === null ? 'true' : undefined}
                fw={projectId === null ? 700 : undefined}
              >
                All projects
              </Anchor>
            </Group>
            {live.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                current={project.id === projectId}
                onChoose={picked(project.id)}
                onRename={() => setDialog({ kind: 'rename', project })}
                onIcon={() => setDialog({ kind: 'icon', project })}
                onArchive={() =>
                  void guarded(() => data.actions.archive(project.id)).catch(() => undefined)
                }
                onDelete={() => void askDelete(project)}
              />
            ))}
          </Stack>
          {archived.length === 0 ? null : (
            <Stack gap={4} aria-label="Archived projects" role="group">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                Archived
              </Text>
              {archived.map((project) => (
                <Group key={project.id} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm">{project.label}</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    aria-label={`Unarchive ${project.label}`}
                    onClick={() =>
                      void guarded(() => data.actions.unarchive(project.id)).catch(() => undefined)
                    }
                  >
                    Unarchive
                  </Button>
                </Group>
              ))}
            </Stack>
          )}
          <ProjectDialogs
            dialog={dialog}
            onClose={() => setDialog(null)}
            actions={{
              create: (name, icon) =>
                guarded(() => data.actions.create({ id: newProjectId(), name, icon })),
              rename: (project, name) => guarded(() => data.actions.rename(project.id, name)),
              setIcon: (project, icon) => guarded(() => data.actions.setIcon(project.id, icon)),
              remove: (project, then) => guarded(() => data.actions.remove(project.id, then)),
            }}
          />
        </>
      )}
    </Stack>
  );
}

export function ProjectsNav(props: { readonly onNavigate?: () => void }): ReactNode {
  const data = useProjects();
  const { servers } = useServers();
  if (data === null && servers.length <= 1) return null;
  const named = servers.length > 1;
  return (
    <Stack component="nav" aria-label="Projects" gap="sm">
      {servers.map((server) => (
        <ServerScope key={server.id} server={server}>
          <ServerProjects
            server={server}
            named={named}
            {...(props.onNavigate === undefined ? {} : { onNavigate: props.onNavigate })}
          />
        </ServerScope>
      ))}
    </Stack>
  );
}

export function ProjectsSidebar(): ReactNode {
  const data = useProjects();
  const { servers } = useServers();
  if (data === null && servers.length <= 1) return null;
  return (
    <Box component="aside" w={240} p="md" style={{ flexShrink: 0 }}>
      <ProjectsNav />
    </Box>
  );
}
